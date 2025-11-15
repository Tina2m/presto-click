# app/main.py
import os, json, uuid, gzip, pathlib, shutil, subprocess
from typing import Optional, Dict, List, Literal, Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --------- sanity: ensure pRESTO tools exist on PATH ----------
import shutil as _shutil
_needed = ["FilterSeq.py","MaskPrimers.py","PairSeq.py","AssemblePairs.py","ParseLog.py","CollapseSeq.py","BuildConsensus.py"]
_missing = [t for t in _needed if not _shutil.which(t)]
if _missing:
    raise RuntimeError(f"pRESTO tools not found on PATH: {', '.join(_missing)}")

# --------- FastAPI app ----------
app = FastAPI(title="pRESTO Click-to-Run Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# (Keep your UI files under app/ui)
app.mount("/ui", StaticFiles(directory="ui", html=True), name="ui")

BASE = pathlib.Path("/data")
BASE.mkdir(parents=True, exist_ok=True)

# --------- Models ----------
class UnitSpec(BaseModel):
    id: str
    label: str
    requires: List[str]
    params_schema: Dict[str, Any]
    # Tag units so the UI can filter bulk vs single-cell
    group: Literal["bulk", "sc"] = "bulk"

    # Quoted types avoid forward-ref problems if this class appears before the models
    def run(self, sess: "SessionState", sess_dir: pathlib.Path, params: Dict[str, Any]) -> "StepResult":
        raise NotImplementedError


class Artifact(BaseModel):
    name: str
    path: str
    kind: Literal["fastq","fasta","tab","log","other"] = "other"
    channel: Optional[Literal["R1","R2","PAIR1","PAIR2","ASSEMBLED"]] = None
    from_step: int

class StepResult(BaseModel):
    step_index: int
    unit: str
    params: Dict[str, Any]
    produced: List[Artifact]

class SessionState(BaseModel):
    session_id: str
    steps: List[StepResult] = []
    artifacts: Dict[str, Artifact] = {}
    current: Dict[str, str] = {}     # channel -> artifact-name
    aux: Dict[str, str] = {}         # e.g. {"v_primers": "Greiff2014_VPrimers.fasta"}
    
def _ensure_uncompressed_path(path: pathlib.Path, dest: pathlib.Path) -> pathlib.Path:
    """If `path` endswith .gz, decompress to `dest` (overwrite) and return dest; else return path."""
    if str(path).lower().endswith(".gz"):
        dest.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "rb") as src, open(dest, "wb") as dst:
            shutil.copyfileobj(src, dst)
        return dest
    return path

def _ensure_uncompressed_art(sess: SessionState, sdir: pathlib.Path, ch: str) -> pathlib.Path:
    """Return an uncompressed path for the current artifact of channel `ch`."""
    key = sess.current.get(ch)
    if not key:
        raise HTTPException(400, f"Channel '{ch}' is not available.")
    art = sess.artifacts[key]
    p = sdir / art.path
    if p.suffix.lower() == ".gz":
        # Decompress alongside with the same basename (without .gz)
        out = p.with_suffix("")  # drop .gz
        if not out.exists():
            with gzip.open(p, "rb") as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
        return out
    return p

def _require_fastq(sess: SessionState, sdir: pathlib.Path, channel_key: str, for_what: str) -> pathlib.Path:
    """Ensure the current artifact is uncompressed FASTQ, else 400 with a helpful message."""
    p = _ensure_uncompressed_art(sess, sdir, channel_key)
    # quick, reliable check by peeking at first non-empty char
    first = _peek_first_nonempty_char(p, gz=False)
    if first != "@":
        raise HTTPException(
            400,
            f"{for_what} requires FASTQ (qualities), but '{p.name}' is not FASTQ. "
            "Upload FASTQ(.gz) or skip this unit."
        )
    return p


def load_state(sess_dir: pathlib.Path) -> SessionState:
    p = sess_dir / "state.json"
    if p.exists():
        return SessionState.model_validate_json(p.read_text())
    s = SessionState(session_id=sess_dir.name)
    p.write_text(s.model_dump_json(indent=2))
    return s

def save_state(sess_dir: pathlib.Path, s: SessionState):
    (sess_dir / "state.json").write_text(s.model_dump_json(indent=2))

# --------- run_cmd: add --nproc when supported, retry w/o ----------
def run_cmd(cmd: List[str], cwd: pathlib.Path, log_file: pathlib.Path):
    nproc = os.cpu_count() or 2
    tool = pathlib.Path(cmd[0]).name
    NPROC_TOOLS = {
        "FilterSeq.py", "MaskPrimers.py", "PairSeq.py",
        "AssemblePairs.py", "CollapseSeq.py", "BuildConsensus.py",
    }
    final_cmd = list(cmd)
    if tool in NPROC_TOOLS and "--nproc" not in final_cmd:
        final_cmd += ["--nproc", str(nproc)]

    with open(log_file, "ab") as log:
        log.write(("[CMD] " + " ".join(final_cmd) + "\n").encode())
        proc = subprocess.Popen(final_cmd, cwd=cwd, stdout=log, stderr=log)
        rc = proc.wait()

    if rc != 0 and "--nproc" in final_cmd:
        # auto-retry without --nproc if unrecognized
        try:
            txt = (log_file.read_text(errors="ignore") or "").lower()
            if "unrecognized arguments" in txt and "--nproc" in txt:
                retry = [x for x in final_cmd if x not in ("--nproc", str(nproc))]
                with open(log_file, "ab") as log:
                    log.write(b"[RETRY] removing --nproc\n")
                    p2 = subprocess.Popen(retry, cwd=cwd, stdout=log, stderr=log)
                    if p2.wait() == 0:
                        return
        except Exception:
            pass

    if rc != 0:
        raise RuntimeError(f"Command failed ({rc}): {' '.join(final_cmd)}")

# --------- FASTA/FASTQ helpers ----------
FASTQ_EXTS = {".fastq", ".fq"}
FASTA_EXTS = {".fasta", ".fa", ".fna"}

def _detect_kind_from_name(name: str) -> Optional[str]:
    """Infer kind from filename (case-insensitive), including *.gz combos."""
    low = name.lower()
    if low.endswith((".fastq.gz", ".fq.gz", ".fastq", ".fq")):
        return "fastq"
    if low.endswith((".fasta.gz", ".fa.gz", ".fna.gz", ".fasta", ".fa", ".fna")):
        return "fasta"
    return None

def _peek_first_nonempty_char(path: pathlib.Path, gz: bool) -> str:
    """Open (gzip/plain) and return first non-empty char ('@' or '>') or ''."""
    opener = gzip.open if gz else open
    try:
        with opener(path, "rt", errors="ignore") as fh:
            for _ in range(200):
                line = fh.readline()
                if not line:
                    break
                s = line.strip()
                if s:
                    return s[0]
    except Exception:
        pass
    return ""

def make_canonical_name(channel: str, kind: str) -> str:
    return f"{channel}.fastq" if kind == "fastq" else f"{channel}.fasta"

def _save_upload_canonical(upload: UploadFile, channel: str, sdir: pathlib.Path) -> Artifact:
    """
    Save uploaded FASTA/FASTQ (.gz or plain) as an uncompressed canonical file:
      R1.fastq / R1.fasta, R2.fastq / R2.fasta.
    """
    tmp_path = sdir / f"__upload__{uuid.uuid4().hex}"
    with open(tmp_path, "wb") as f:
        shutil.copyfileobj(upload.file, f)

    # 1) Try filename-based detection (most reliable for gz)
    kind = _detect_kind_from_name(upload.filename)

    # 2) If still unknown, peek inside (handle gz/plain correctly)
    if kind is None:
        first = _peek_first_nonempty_char(tmp_path, gz=upload.filename.lower().endswith(".gz"))
        if first == ">":
            kind = "fasta"
        elif first == "@":
            kind = "fastq"

    if kind not in ("fastq", "fasta"):
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(400, f"Unsupported upload type for '{upload.filename}'; expected FASTA/FASTQ(.gz).")

    out_name = make_canonical_name(channel, kind)
    out_path = sdir / out_name

    # 3) Decompress if needed, always store uncompressed canonical file
    if upload.filename.lower().endswith(".gz"):
        with gzip.open(tmp_path, "rb") as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst)
        tmp_path.unlink(missing_ok=True)
    else:
        tmp_path.replace(out_path)

    return Artifact(name=f"{channel}_raw", path=out_name, kind=kind, channel=channel, from_step=-1)

# --------- misc helpers ----------
def file_existing(sess_dir: pathlib.Path, *candidates: str) -> str:
    for c in candidates:
        if (sess_dir / c).exists():
            return c
    raise HTTPException(500, f"Expected output not found. Tried: {candidates}")

def find_pass_for_prefix(sess_dir: pathlib.Path, prefix: str) -> str:
    for ext in ("fastq.gz","fastq","fasta.gz","fasta"):
        for tag in ("mask-pass","align-primers-pass","primers-pass","extract-pass","quality-pass",
                    "length-pass","missing-pass","repeats-pass","trimqual-pass","maskqual-pass",
                    "assemble-pass","collapse-pass"):
            p = sess_dir / f"{prefix}_{tag}.{ext}"
            if p.exists(): return p.name
    raise HTTPException(500, f"Expected output not found for prefix '{prefix}'.")

def _assert_channel(sess: SessionState, ch: str):
    if ch not in sess.current:
        raise HTTPException(400, f"Required channel '{ch}' is not available.")

# --------- Units ----------
class UnitSpec(BaseModel):
    id: str
    label: str
    requires: List[str]
    params_schema: Dict[str, Any]
    def run(self, sess: SessionState, sess_dir: pathlib.Path, params: Dict[str, Any]) -> StepResult:
        raise NotImplementedError

def _next_idx(sess: SessionState) -> int: return len(sess.steps)

# FilterSeq units
class U_FilterQuality(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_FilterSeq_quality.log"
        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        q = str(params.get("qmin", 20))
        run_cmd(["FilterSeq.py","quality","-s",str(r1),"-q",q,"--outname",f"R1_q{q}","--log",log.name], sdir, log)
        out_r1 = find_pass_for_prefix(sdir, f"R1_q{q}")
        produced = [Artifact(name="R1_quality", path=out_r1, kind="fastq", channel="R1", from_step=idx)]
        if sess.current.get("R2"):
            r2 = sdir / sess.artifacts[sess.current["R2"]].path
            run_cmd(["FilterSeq.py","quality","-s",str(r2),"-q",q,"--outname",f"R2_q{q}","--log",log.name], sdir, log)
            out_r2 = find_pass_for_prefix(sdir, f"R2_q{q}")
            produced.append(Artifact(name="R2_quality", path=out_r2, kind="fastq", channel="R2", from_step=idx))
            sess.current["R2"] = "R2_quality"
        sess.current["R1"] = "R1_quality"
        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_FilterLength(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_FilterSeq_length.log"
        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        n = str(params.get("min_len", 100))
        cmd = ["FilterSeq.py","length","-s",str(r1),"-n",n,"--outname",f"R1_len{n}","--log",log.name]
        if str(params.get("inner","false")).lower() in ("1","true","yes","y"): cmd.append("--inner")
        run_cmd(cmd, sdir, log)
        out_r1 = find_pass_for_prefix(sdir, f"R1_len{n}")
        produced = [Artifact(name="R1_length", path=out_r1, kind="fastq", channel="R1", from_step=idx)]
        if sess.current.get("R2"):
            r2 = sdir / sess.artifacts[sess.current["R2"]].path
            cmd2 = ["FilterSeq.py","length","-s",str(r2),"-n",n,"--outname",f"R2_len{n}","--log",log.name]
            if str(params.get("inner","false")).lower() in ("1","true","yes","y"): cmd2.append("--inner")
            run_cmd(cmd2, sdir, log)
            out_r2 = find_pass_for_prefix(sdir, f"R2_len{n}")
            produced.append(Artifact(name="R2_length", path=out_r2, kind="fastq", channel="R2", from_step=idx))
            sess.current["R2"] = "R2_length"
        sess.current["R1"] = "R1_length"
        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_FilterMissing(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_FilterSeq_missing.log"
        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        n = str(params.get("max_missing", 10))
        cmd = ["FilterSeq.py","missing","-s",str(r1),"-n",n,"--outname",f"R1_m{n}","--log",log.name]
        if str(params.get("inner","false")).lower() in ("1","true","yes","y"): cmd.append("--inner")
        run_cmd(cmd, sdir, log)
        out_r1 = find_pass_for_prefix(sdir, f"R1_m{n}")
        produced = [Artifact(name="R1_missing", path=out_r1, kind="fastq", channel="R1", from_step=idx)]
        if sess.current.get("R2"):
            r2 = sdir / sess.artifacts[sess.current["R2"]].path
            cmd2 = ["FilterSeq.py","missing","-s",str(r2),"-n",n,"--outname",f"R2_m{n}","--log",log.name]
            if str(params.get("inner","false")).lower() in ("1","true","yes","y"): cmd2.append("--inner")
            run_cmd(cmd2, sdir, log)
            out_r2 = find_pass_for_prefix(sdir, f"R2_m{n}")
            produced.append(Artifact(name="R2_missing", path=out_r2, kind="fastq", channel="R2", from_step=idx))
            sess.current["R2"] = "R2_missing"
        sess.current["R1"] = "R1_missing"
        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_FilterRepeats(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_FilterSeq_repeats.log"
        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        n = str(params.get("max_repeat","0.8"))
        cmd = ["FilterSeq.py","repeats","-s",str(r1),"-n",n,"--outname",f"R1_rep{n}","--log",log.name]
        if str(params.get("missing","false")).lower() in ("1","true","yes","y"): cmd.append("--missing")
        if str(params.get("inner","false")).lower() in ("1","true","yes","y"): cmd.append("--inner")
        run_cmd(cmd, sdir, log)
        out_r1 = find_pass_for_prefix(sdir, f"R1_rep{n}")
        produced = [Artifact(name="R1_repeats", path=out_r1, kind="fastq", channel="R1", from_step=idx)]
        if sess.current.get("R2"):
            r2 = sdir / sess.artifacts[sess.current["R2"]].path
            cmd2 = ["FilterSeq.py","repeats","-s",str(r2),"-n",n,"--outname",f"R2_rep{n}","--log",log.name]
            if str(params.get("missing","false")).lower() in ("1","true","yes","y"): cmd2.append("--missing")
            if str(params.get("inner","false")).lower() in ("1","true","yes","y"): cmd2.append("--inner")
            run_cmd(cmd2, sdir, log)
            out_r2 = find_pass_for_prefix(sdir, f"R2_rep{n}")
            produced.append(Artifact(name="R2_repeats", path=out_r2, kind="fastq", channel="R2", from_step=idx))
            sess.current["R2"] = "R2_repeats"
        sess.current["R1"] = "R1_repeats"
        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_FilterTrimQual(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_FilterSeq_trimqual.log"
        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        q = str(params.get("qmin", 20)); win = params.get("window", 10)
        cmd = ["FilterSeq.py","trimqual","-s",str(r1),"-q",q,"--outname",f"R1_tq{q}","--log",log.name]
        if win: cmd += ["--win", str(win)]
        if str(params.get("reverse","false")).lower() in ("1","true","yes","y"): cmd.append("--reverse")
        run_cmd(cmd, sdir, log)
        out_r1 = find_pass_for_prefix(sdir, f"R1_tq{q}")
        produced = [Artifact(name="R1_trimqual", path=out_r1, kind="fastq", channel="R1", from_step=idx)]
        if sess.current.get("R2"):
            r2 = sdir / sess.artifacts[sess.current["R2"]].path
            cmd2 = ["FilterSeq.py","trimqual","-s",str(r2),"-q",q,"--outname",f"R2_tq{q}","--log",log.name]
            if win: cmd2 += ["--win", str(win)]
            if str(params.get("reverse","false")).lower() in ("1","true","yes","y"): cmd2.append("--reverse")
            run_cmd(cmd2, sdir, log)
            out_r2 = find_pass_for_prefix(sdir, f"R2_tq{q}")
            produced.append(Artifact(name="R2_trimqual", path=out_r2, kind="fastq", channel="R2", from_step=idx))
            sess.current["R2"] = "R2_trimqual"
        sess.current["R1"] = "R1_trimqual"
        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_FilterMaskQual(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_FilterSeq_maskqual.log"
        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        q = str(params.get("qmin", 20))
        run_cmd(["FilterSeq.py","maskqual","-s",str(r1),"-q",q,"--outname",f"R1_mq{q}","--log",log.name], sdir, log)
        out_r1 = find_pass_for_prefix(sdir, f"R1_mq{q}")
        produced = [Artifact(name="R1_maskqual", path=out_r1, kind="fastq", channel="R1", from_step=idx)]
        if sess.current.get("R2"):
            r2 = sdir / sess.artifacts[sess.current["R2"]].path
            run_cmd(["FilterSeq.py","maskqual","-s",str(r2),"-q",q,"--outname",f"R2_mq{q}","--log",log.name], sdir, log)
            out_r2 = find_pass_for_prefix(sdir, f"R2_mq{q}")
            produced.append(Artifact(name="R2_maskqual", path=out_r2, kind="fastq", channel="R2", from_step=idx))
            sess.current["R2"] = "R2_maskqual"
        sess.current["R1"] = "R1_maskqual"
        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

# MaskPrimers combined
class U_MaskPrimers(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess)
        variant = params.get("variant","align")
        mode = params.get("mode","mask")
        log = sdir / f"{idx:03d}_MaskPrimers_{variant}.log"

        _assert_channel(sess, "R1"); r1 = sdir / sess.artifacts[sess.current["R1"]].path
        produced: List[Artifact] = []

        if variant in ("align","score"):
            v_name = params.get("v_primers_fname") or load_state(sdir).aux.get("v_primers")
            if not v_name:
                raise HTTPException(400, "v_primers_fname is required for align/score.")
            v_fa = sdir / v_name
            cmd = ["MaskPrimers.py", variant, "-s", str(r1), "-p", str(v_fa),
                   "--mode", mode, "--pf", "VPRIMER", "--outname", "R1", "--log", log.name]
            if str(params.get("revpr","false")).lower() in ("1","true","yes","y"):
                cmd.append("--revpr")
            run_cmd(cmd, sdir, log)
            out_r1 = find_pass_for_prefix(sdir, "R1")
            produced.append(Artifact(name="R1_masked", path=out_r1, kind="fastq", channel="R1", from_step=idx))
            sess.current["R1"] = "R1_masked"

            if sess.current.get("R2"):
                c_name = params.get("c_primers_fname") or load_state(sdir).aux.get("c_primers")
                if c_name:
                    r2 = sdir / sess.artifacts[sess.current["R2"]].path
                    c_fa = sdir / c_name
                    cmd2 = ["MaskPrimers.py", variant, "-s", str(r2), "-p", str(c_fa),
                            "--mode", mode, "--pf", "CPRIMER", "--outname", "R2", "--log", log.name]
                    if str(params.get("revpr","false")).lower() in ("1","true","yes","y"):
                        cmd2.append("--revpr")
                    run_cmd(cmd2, sdir, log)
                    out_r2 = find_pass_for_prefix(sdir, "R2")
                    produced.append(Artifact(name="R2_masked", path=out_r2, kind="fastq", channel="R2", from_step=idx))
                    sess.current["R2"] = "R2_masked"

        elif variant == "extract":
            try:
                start = int(params.get("start")); length = int(params.get("length"))
            except Exception:
                raise HTTPException(400, "extract requires integer 'start' and 'length'.")
            cmd = ["MaskPrimers.py","extract","-s",str(r1),"--start",str(start),"--len",str(length),
                   "--mode",mode,"--pf","EXTRACT","--outname","R1","--log",log.name]
            run_cmd(cmd, sdir, log)
            out_r1 = find_pass_for_prefix(sdir, "R1")
            produced.append(Artifact(name="R1_extracted", path=out_r1, kind="fastq", channel="R1", from_step=idx))
            sess.current["R1"] = "R1_extracted"

            if sess.current.get("R2"):
                r2 = sdir / sess.artifacts[sess.current["R2"]].path
                cmd2 = ["MaskPrimers.py","extract","-s",str(r2),"--start",str(start),"--len",str(length),
                        "--mode",mode,"--pf","EXTRACT","--outname","R2","--log",log.name]
                run_cmd(cmd2, sdir, log)
                out_r2 = find_pass_for_prefix(sdir, "R2")
                produced.append(Artifact(name="R2_extracted", path=out_r2, kind="fastq", channel="R2", from_step=idx))
                sess.current["R2"] = "R2_extracted"
        else:
            raise HTTPException(400, f"Unsupported variant '{variant}'. Choose from align, score, extract.")

        for a in produced: sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

# Pairing & Assembly
class U_PairSeq(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_PairSeq.log"
        _assert_channel(sess,"R1"); _assert_channel(sess,"R2")
        r1 = sdir / sess.artifacts[sess.current["R1"]].path
        r2 = sdir / sess.artifacts[sess.current["R2"]].path
        coord = params.get("coord","illumina")
        # PairSeq.py does not accept --log; run_cmd will still capture stdout/stderr in log_file
        run_cmd(["PairSeq.py","-1",str(r1),"-2",str(r2),"--coord",coord,"--outname","PAIRED"], sdir, log)
        a1 = Artifact(name="PAIR1", path="PAIRED-1_pair-pass.fastq.gz", kind="fastq", channel="PAIR1", from_step=idx)
        a2 = Artifact(name="PAIR2", path="PAIRED-2_pair-pass.fastq.gz", kind="fastq", channel="PAIR2", from_step=idx)
        if not (sdir / a1.path).exists(): a1.path = "PAIRED-1_pair-pass.fastq"
        if not (sdir / a2.path).exists(): a2.path = "PAIRED-2_pair-pass.fastq"
        sess.artifacts[a1.name] = a1; sess.artifacts[a2.name] = a2
        sess.current["PAIR1"] = a1.name; sess.current["PAIR2"] = a2.name
        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a1,a2])

class U_AssembleAlign(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_AssemblePairs_align.log"
        for ch in ("PAIR1","PAIR2"):
            if ch not in sess.current:
                raise HTTPException(400, "AssemblePairs requires PAIR1 and PAIR2 (run PairSeq first).")
        p1 = sdir / sess.artifacts[sess.current["PAIR1"]].path
        p2 = sdir / sess.artifacts[sess.current["PAIR2"]].path
        coord = params.get("coord","illumina")
        rc = params.get("rc","tail")
        cmd = ["AssemblePairs.py","align","-1",str(p1),"-2",str(p2),"--coord",coord,"--rc",rc,
               "--outname","ASSEMBLED","--log",log.name]
        # optional de-novo tuning
        if params.get("alpha"):    cmd += ["--alpha", str(params["alpha"])]
        if params.get("maxerror"): cmd += ["--maxerror", str(params["maxerror"])]
        if params.get("minlen"):   cmd += ["--minlen", str(params["minlen"])]
        if params.get("maxlen"):   cmd += ["--maxlen", str(params["maxlen"])]
        run_cmd(cmd, sdir, log)
        run_cmd(["ParseLog.py","-l",log.name,"-f","ID","LENGTH","OVERLAP","ERROR","PVALUE","--outname","AP"], sdir, log)
        a = Artifact(name="ASSEMBLED", path="ASSEMBLED_assemble-pass.fastq.gz", kind="fastq", channel="ASSEMBLED", from_step=idx)
        if not (sdir / a.path).exists(): a.path = "ASSEMBLED_assemble-pass.fastq"
        t = Artifact(name="AP_table", path="AP_table.tab", kind="tab", from_step=idx)
        sess.artifacts[a.name] = a; sess.artifacts[t.name] = t; sess.current["ASSEMBLED"] = a.name
        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a,t])

class U_AssembleJoin(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_AssemblePairs_join.log"
        for ch in ("PAIR1","PAIR2"):
            if ch not in sess.current:
                raise HTTPException(400, "AssemblePairs join requires PAIR1 and PAIR2 (run PairSeq first).")
        p1 = sdir / sess.artifacts[sess.current["PAIR1"]].path
        p2 = sdir / sess.artifacts[sess.current["PAIR2"]].path
        coord = params.get("coord","illumina")
        rc = params.get("rc","tail")
        cmd = ["AssemblePairs.py","join","-1",str(p1),"-2",str(p2),"--coord",coord,"--rc",rc,
               "--outname","ASSEMBLED","--log",log.name]
        if params.get("head_fields"): cmd += ["--1f"] + str(params["head_fields"]).split(",")
        if params.get("tail_fields"): cmd += ["--2f"] + str(params["tail_fields"]).split(",")
        if params.get("gap"): cmd += ["--gap", str(params["gap"])]
        run_cmd(cmd, sdir, log)
        a = Artifact(name="ASSEMBLED", path="ASSEMBLED_assemble-pass.fastq.gz", kind="fastq", channel="ASSEMBLED", from_step=idx)
        if not (sdir / a.path).exists(): a.path = "ASSEMBLED_assemble-pass.fastq"
        sess.artifacts[a.name] = a; sess.current["ASSEMBLED"] = a.name
        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a])

class U_AssembleSequential(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_AssemblePairs_sequential.log"
        for ch in ("PAIR1","PAIR2"):
            if ch not in sess.current:
                raise HTTPException(400, "AssemblePairs sequential requires PAIR1 and PAIR2 (run PairSeq first).")
        p1 = sdir / sess.artifacts[sess.current["PAIR1"]].path
        p2 = sdir / sess.artifacts[sess.current["PAIR2"]].path
        coord = params.get("coord","illumina"); rc = params.get("rc","tail")
        cmd = ["AssemblePairs.py","sequential","-1",str(p1),"-2",str(p2),"--coord",coord,"--rc",rc,
               "--outname","ASSEMBLED","--log",log.name]
        if params.get("head_fields"): cmd += ["--1f"] + str(params["head_fields"]).split(",")
        if params.get("tail_fields"): cmd += ["--2f"] + str(params["tail_fields"]).split(",")
        for k,flag in (("alpha","--alpha"),("maxerror","--maxerror"),("minlen","--minlen"),("maxlen","--maxlen")):
            if params.get(k): cmd += [flag, str(params[k])]
        if str(params.get("scanrev","false")).lower() in ("1","true","yes","y"): cmd.append("--scanrev")
        if params.get("ref_file"):  cmd += ["-r", str(params["ref_file"])]
        if params.get("minident"):  cmd += ["--minident", str(params["minident"])]
        if params.get("evalue"):    cmd += ["--evalue", str(params["evalue"])]
        if params.get("maxhits"):   cmd += ["--maxhits", str(params["maxhits"])]
        if params.get("aligner"):   cmd += ["--aligner", str(params["aligner"])]
        run_cmd(cmd, sdir, log)
        a = Artifact(name="ASSEMBLED", path="ASSEMBLED_assemble-pass.fastq.gz", kind="fastq", channel="ASSEMBLED", from_step=idx)
        if not (sdir / a.path).exists(): a.path = "ASSEMBLED_assemble-pass.fastq"
        sess.artifacts[a.name] = a; sess.current["ASSEMBLED"] = a.name
        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a])

class U_CollapseSeq(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_CollapseSeq.log"
        # default: collapse what's "current": assembled if present else R1
        key = sess.current.get("ASSEMBLED") or sess.current.get("R1")
        if not key: raise HTTPException(400, "CollapseSeq needs a FASTQ to collapse (e.g., assembled or R1).")
        src = sdir / sess.artifacts[key].path
        outname = params.get("outname","COLLAPSE")
        cmd = ["CollapseSeq.py","-s",str(src),"--outname",outname,"--log",log.name]
        if params.get("act"): cmd += ["--act", str(params["act"])]
        run_cmd(cmd, sdir, log)
        a = Artifact(name="COLLAPSED", path=f"{outname}_collapse-pass.fastq.gz", kind="fastq", from_step=idx)
        if not (sdir / a.path).exists(): a.path = f"{outname}_collapse-pass.fastq"
        sess.artifacts[a.name] = a; sess.current["ASSEMBLED"] = a.name
        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a])

class U_BuildConsensus(UnitSpec):
    def run(self, sess, sdir, params):
        idx = _next_idx(sess); log = sdir / f"{idx:03d}_BuildConsensus.log"
        key = sess.current.get("ASSEMBLED") or sess.current.get("R1")
        if not key: raise HTTPException(400, "BuildConsensus needs a FASTQ/FASTA (assembled or R1).")
        src = sdir / sess.artifacts[key].path
        outprefix = "CONS"
        cmd = ["BuildConsensus.py","-s",str(src),"--outname",outprefix,"--log",log.name]
        # optional
        if params.get("qmin"):    cmd += ["-q", str(params["qmin"])]
        if params.get("freq"):    cmd += ["--freq", str(params["freq"])]
        if params.get("maxgap"):  cmd += ["--maxgap", str(params["maxgap"])]
        if params.get("act"):
            acts = str(params["act"]).split(",")
            cmd += ["--act"] + acts
        if str(params.get("dep","false")).lower() in ("1","true","yes","y"):
            cmd += ["--dep"]
        # exclusive maxdiv / maxerror
        if params.get("maxdiv"):   cmd += ["--maxdiv", str(params["maxdiv"])]
        elif params.get("maxerror"): cmd += ["--maxerror", str(params["maxerror"])]
        run_cmd(cmd, sdir, log)
        # BuildConsensus creates multiple outputs; keep the consensus-pass.* as representative
        out = find_pass_for_prefix(sdir, f"{outprefix}_consensus")
        a = Artifact(name="CONSENSUS", path=out, kind="fastq", from_step=idx)
        sess.artifacts[a.name] = a
        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a])
    
class U_MergeSamples(UnitSpec):
    """
    Merge multiple AIRR-C rearrangement tables using airr::read_rearrangement.
    - files: comma/space-separated list of filenames stored in this session (optional).
             If omitted, all *.tsv and *.tsv.gz in the session directory are used.
    - aux_types: key=type pairs (e.g. "v_germline_length=i, d_germline_length=i, j_germline_length=i, day=i").
                 Defaults to those four integers if omitted.
    - sample_field: column name to annotate each row with filename stem (default "sample_id"; set empty to skip).
    Output: MERGED.tsv
    """
    def run(self, sess, sess_dir, params):
        import re
        idx = _next_idx(sess)
        log = sess_dir / f"{idx:03d}_SC_MergeSamples.log"

        # Collect files
        files_param = (params.get("files") or "").strip()
        if files_param:
            # split by comma/space
            names = [n for n in re.split(r"[,\s]+", files_param) if n]
        else:
            # default: all TSV/TSV.GZ in session
            names = sorted([p.name for p in sess_dir.glob("*.tsv")] + [p.name for p in sess_dir.glob("*.tsv.gz")])

        if not names:
            raise HTTPException(400, "No input tables. Upload AIRR TSVs (use 'Upload aux') or provide 'files' list.")

        paths = []
        for n in names:
            p = sess_dir / n
            if not p.exists():
                raise HTTPException(400, f"File not found in session: {n}")
            paths.append(str(p))

        # aux_types mapping
        aux_default = "v_germline_length=i, d_germline_length=i, j_germline_length=i, day=i"
        aux_str = (params.get("aux_types") or aux_default).strip()

        # convert to R named vector literal: c('k'='i','k2'='i',...)
        pairs = []
        for part in re.split(r"[,\s]+", aux_str):
            if not part or "=" not in part: continue
            k,v = part.split("=",1)
            k = k.strip(); v = v.strip()
            if not k or not v: continue
            pairs.append(f"'{k}'='{v}'")
        r_aux_vec = "c(" + ",".join(pairs) + ")" if pairs else "c()"

        sample_field = (params.get("sample_field") if params.get("sample_field") is not None else "sample_id")
        sample_field = str(sample_field).strip()

        # Write a small R script into the session
        rfile = sess_dir / f"{idx:03d}_merge_samples.R"
        r_code = f"""
            args <- commandArgs(trailingOnly=TRUE)
            out <- args[1]
            files <- args[-1]
            suppressPackageStartupMessages(library(airr))
            aux_types <- {r_aux_vec}
            sfield <- {repr(sample_field)}

            read_one <- function(f) {{
            df <- airr::read_rearrangement(f, aux_types = aux_types)
            if (nchar(sfield) > 0) {{
                base <- basename(f)
                base <- sub("\\\\.[^.]+$", "", base)
                df[[sfield]] <- base
            }}
            df
            }}

            lst <- lapply(files, read_one)
            merged <- do.call(rbind, lst)
            write.table(merged, file=out, sep="\\t", quote=FALSE, row.names=FALSE)
        """
        rfile.write_text(r_code, encoding="utf-8")

        # Run Rscript
        out_path = sess_dir / "MERGED.tsv"
        cmd = ["Rscript", "--vanilla", rfile.name, out_path.name] + paths
        run_cmd(cmd, sess_dir, log)

        a = Artifact(name="SC_MERGED", path=out_path.name, kind="tab", from_step=idx)
        sess.artifacts[a.name] = a
        # Track a single-cell table "channel" for downstream SC units
        sess.current["SC_TABLE"] = a.name

        return StepResult(step_index=idx, unit=self.id, params=params, produced=[a])
    
class U_SC_FilterProductive(UnitSpec):
    """
    Single-cell: Remove non-productive sequences independently of other steps.

    Parameters
    ----------
    files : text (optional)
        Comma/space separated list of TSV/TSV.GZ files already uploaded to this session.
        If empty, all *.tsv / *.tsv.gz in the session directory are used.
    productive_field : text
        Column to test for truthy values (default: 'productive').
    fallback_from_airr : select {'true','false'}
        If productive_field is missing, try computing productivity as
        (vj_in_frame == TRUE) & (stop_codon == FALSE). Default true.
    mode : select {'merge','per_file'}
        'merge' produces one file (SC_productive.tsv) and sets SC_TABLE to it.
        'per_file' writes SC_prod_<basename>.tsv for each input file and sets SC_TABLE
        to the first produced file (so you can chain if desired).
    sample_field : text
        When mode='merge' and non-empty, a new column with this name is added containing
        the input filename stem.
    """
    def run(self, sess, sess_dir, params):
        import re
        idx = _next_idx(sess)
        log = sess_dir / f"{idx:03d}_SC_FilterProductive.log"

        # -------- inputs ----------
        files_param = (params.get("files") or "").strip()
        if files_param:
            names = [n for n in re.split(r"[,\s]+", files_param) if n]
        else:
            names = sorted([p.name for p in sess_dir.glob("*.tsv")] +
                           [p.name for p in sess_dir.glob("*.tsv.gz")])

        if not names:
            raise HTTPException(400, "No TSVs found. Upload AIRR TSV/TSV.GZ via 'Upload inputs' or specify 'files'.")

        for n in names:
            if not (sess_dir / n).exists():
                raise HTTPException(400, f"File not found in session: {n}")

        pf   = (params.get("productive_field") or "productive").strip() or "productive"
        fb   = str(params.get("fallback_from_airr", "true")).lower() in ("1","true","yes","y")
        mode = (params.get("mode") or "merge").strip().lower()
        if mode not in ("merge","per_file"):
            mode = "merge"
        sfield = (params.get("sample_field") or "sample_id").strip()

        # -------- R script ----------
        rfile = sess_dir / f"{idx:03d}_sc_filter_productive.R"
        out_merged = "SC_productive.tsv"
        # We pass: out_merged, mode, sfield, pf, fallbackFlag, then files...
        r_code = f"""
args <- commandArgs(trailingOnly=TRUE)
out_merged <- args[1]
mode <- args[2]
sfield <- args[3]
pf <- {repr(pf)}
fallbackFlag <- as.logical({str(fb).upper()})
files <- args[-(1:3)]

truthy <- c(TRUE, "TRUE", "T", "true", "True", 1, "1")

filter_one <- function(f){{
  df <- tryCatch({{
    read.delim(f, header=TRUE, sep="\\t", check.names=FALSE, stringsAsFactors=FALSE)
  }}, error=function(e) {{
    stop(paste("Failed to read:", f, "->", e$message))
  }})

  # compute keep mask
  if (pf %in% colnames(df)) {{
    keep <- df[[pf]] %in% truthy
  }} else if (fallbackFlag && all(c("vj_in_frame","stop_codon") %in% colnames(df))) {{
    # AIRR fallback: productive if in-frame and no stop codon
    keep <- (df[["vj_in_frame"]] %in% truthy) & !(df[["stop_codon"]] %in% truthy)
  }} else {{
    warning(paste("No productive field and no AIRR fallback columns; keeping all rows for", f))
    keep <- rep(TRUE, nrow(df))
  }}

  df2 <- df[keep, , drop=FALSE]
  df2
}}

if (mode == "per_file") {{
  for (f in files) {{
    df2 <- filter_one(f)
    base <- basename(f)
    base <- sub("\\\\.[^.]+$", "", base)
    out <- paste0("SC_prod_", base, ".tsv")
    write.table(df2, file=out, sep="\\t", quote=FALSE, row.names=FALSE)
    cat(paste("Wrote", out, "rows:", nrow(df2), "\\n"))
  }}
}} else {{
  lst <- lapply(files, filter_one)
  if (length(lst) == 0) {{
    stop("No input tables after filtering.")
  }}
  merged <- do.call(rbind, lst)
  if (nchar(sfield) > 0) {{
    # annotate origin by filename stem
    # We need to repeat the origin per row; rebuild using files and nrow of filtered fragments
    origins <- unlist(lapply(seq_along(files), function(i){{
      f <- files[[i]]
      base <- sub("\\\\.[^.]+$", "", basename(f))
      n <- nrow(lst[[i]])
      if (n <= 0) return(character(0))
      rep(base, n)
    }}))
    if (length(origins) == nrow(merged)) {{
      merged[[sfield]] <- origins
    }} else {{
      warning("Could not build origin column (row mismatch). Skipping.")
    }}
  }}
  write.table(merged, file=out_merged, sep="\\t", quote=FALSE, row.names=FALSE)
  cat(paste("Wrote", out_merged, "rows:", nrow(merged), "\\n"))
}}
"""
        rfile.write_text(r_code, encoding="utf-8")

        cmd = ["Rscript", "--vanilla", rfile.name, out_merged, mode, sfield] + names
        run_cmd(cmd, sess_dir, log)

        produced = []
        if mode == "per_file":
            # Register every produced SC_prod_<stem>.tsv
            for n in names:
                stem = re.sub(r"\\.[^.]+$", "", n)
                out = f"SC_prod_{stem}.tsv"
                if (sess_dir / out).exists():
                    a = Artifact(name=f"SC_PROD_{stem}", path=out, kind="tab", from_step=idx)
                    sess.artifacts[a.name] = a
                    produced.append(a)
            # set SC_TABLE to the first produced (if any)
            if produced:
                sess.current["SC_TABLE"] = produced[0].name
        else:
            # merge mode: one output
            a = Artifact(name="SC_PRODUCTIVE", path=out_merged, kind="tab", from_step=idx)
            sess.artifacts[a.name] = a
            produced.append(a)
            sess.current["SC_TABLE"] = a.name

        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_SC_RemoveMultiHeavy(UnitSpec):
    """
    Single-cell: remove cells that have multiple heavy-chain rearrangements.

    Parameters
    ----------
    files : text (optional)
        Comma/space-separated list of TSV/TSV.GZ files uploaded to this session.
        If empty, uses all *.tsv / *.tsv.gz in the session directory.
    locus_field : text
        Column that denotes chain locus (default: 'locus').
    heavy_value : text
        Value that denotes the heavy locus (default: 'IGH').
    cell_field : text
        Column with the cell identifier (default: 'cell_id')  — REQUIRED in input.
    fallback_from_vcall : select {'true','false'}
        If `locus_field` is missing, detect heavy with grepl('^IGH', v_call) (default true).
    mode : select {'merge','per_file'}
        'merge' → one file SC_no_multi_heavy.tsv; 'per_file' → one file per input.
        In both cases SC_TABLE is set (first produced when per_file).
    sample_field : text
        When merging and non-empty, annotate each row with the filename stem.

    Output
    ------
    - merge: SC_no_multi_heavy.tsv
    - per_file: SC_noMH_<basename>.tsv per input
    """
    def run(self, sess, sess_dir, params):
        import re
        idx = _next_idx(sess)
        log = sess_dir / f"{idx:03d}_SC_RemoveMultiHeavy.log"

        # ---- inputs ----
        files_param = (params.get("files") or "").strip()
        if files_param:
            names = [n for n in re.split(r"[,\s]+", files_param) if n]
        else:
            names = sorted([p.name for p in sess_dir.glob("*.tsv")] +
                           [p.name for p in sess_dir.glob("*.tsv.gz")])
        if not names:
            raise HTTPException(400, "No TSVs found. Upload TSV/TSV.GZ or provide 'files'.")

        for n in names:
            if not (sess_dir / n).exists():
                raise HTTPException(400, f"File not found in session: {n}")

        locus_field = (params.get("locus_field") or "locus").strip() or "locus"
        heavy_value = (params.get("heavy_value") or "IGH").strip() or "IGH"
        cell_field  = (params.get("cell_field")  or "cell_id").strip() or "cell_id"
        fb          = str(params.get("fallback_from_vcall", "true")).lower() in ("1","true","yes","y")
        mode        = (params.get("mode") or "merge").strip().lower()
        if mode not in ("merge","per_file"):
            mode = "merge"
        sfield      = (params.get("sample_field") or "sample_id").strip()

        # ---- R script ----
        rfile = sess_dir / f"{idx:03d}_sc_remove_multi_heavy.R"
        out_merged = "SC_no_multi_heavy.tsv"
        # pass: out_merged, mode, sfield, locus_field, heavy_value, cell_field, fallbackFlag, then files...
        r_code = f"""
args <- commandArgs(trailingOnly=TRUE)
out_merged <- args[1]
mode <- args[2]
sfield <- args[3]
locus_field <- {repr(locus_field)}
heavy_value <- {repr(heavy_value)}
cell_field <- {repr(cell_field)}
fallbackFlag <- as.logical({str(fb).upper()})
files <- args[-(1:3)]

read_one <- function(f){{
  df <- tryCatch({{
    read.delim(f, header=TRUE, sep="\\t", check.names=FALSE, stringsAsFactors=FALSE)
  }}, error=function(e) {{
    stop(paste("Failed to read:", f, "->", e$message))
  }})
  if (!(cell_field %in% colnames(df))) {{
    stop(paste("Column", cell_field, "not found in", f))
  }}

  # Identify heavy chains
  if (locus_field %in% colnames(df)) {{
    heavy_mask <- (df[[locus_field]] == heavy_value)
  }} else if (fallbackFlag && ("v_call" %in% colnames(df))) {{
    heavy_mask <- grepl("^IGH", as.character(df[["v_call"]]))
  }} else {{
    warning(paste("No", locus_field, "and no v_call; assuming no heavy calls in", f))
    heavy_mask <- rep(FALSE, nrow(df))
  }}

  # Find cells with >1 heavy
  heavy_cells <- df[heavy_mask, cell_field]
  tab <- table(heavy_cells)
  multi_cells <- names(tab[tab > 1])

  # Filter out those cells
  keep <- !(df[[cell_field]] %in% multi_cells)
  df2 <- df[keep, , drop=FALSE]
  df2
}}

if (mode == "per_file") {{
  for (f in files) {{
    df2 <- read_one(f)
    base <- sub("\\\\.[^.]+$", "", basename(f))
    out <- paste0("SC_noMH_", base, ".tsv")
    write.table(df2, file=out, sep="\\t", quote=FALSE, row.names=FALSE)
    cat(paste("Wrote", out, "rows:", nrow(df2), "\\n"))
  }}
}} else {{
  lst <- lapply(files, read_one)
  if (length(lst) == 0) {{
    stop("No input tables after filtering.")
  }}
  merged <- do.call(rbind, lst)
  if (nchar(sfield) > 0) {{
    origins <- unlist(lapply(seq_along(files), function(i){{
      base <- sub("\\\\.[^.]+$", "", basename(files[[i]]))
      n <- nrow(lst[[i]])
      if (n <= 0) return(character(0))
      rep(base, n)
    }}))
    if (length(origins) == nrow(merged)) {{
      merged[[sfield]] <- origins
    }} else {{
      warning("Could not add origin column (row mismatch).")
    }}
  }}
  write.table(merged, file=out_merged, sep="\\t", quote=FALSE, row.names=FALSE)
  cat(paste("Wrote", out_merged, "rows:", nrow(merged), "\\n"))
}}
"""
        rfile.write_text(r_code, encoding="utf-8")

        cmd = ["Rscript", "--vanilla", rfile.name, out_merged, mode, sfield] + names
        run_cmd(cmd, sess_dir, log)

        produced = []
        if mode == "per_file":
            for n in names:
                stem = re.sub(r"\.[^.]+$", "", n)
                out = f"SC_noMH_{stem}.tsv"
                if (sess_dir / out).exists():
                    a = Artifact(name=f"SC_NOMH_{stem}", path=out, kind="tab", from_step=idx)
                    sess.artifacts[a.name] = a
                    produced.append(a)
            if produced:
                sess.current["SC_TABLE"] = produced[0].name
        else:
            a = Artifact(name="SC_NO_MULTI_HEAVY", path=out_merged, kind="tab", from_step=idx)
            sess.artifacts[a.name] = a
            produced.append(a)
            sess.current["SC_TABLE"] = a.name

        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

class U_SC_RemoveNoHeavy(UnitSpec):
    """
    Single-cell: remove cells that have only light chains (no heavy).

    Parameters
    ----------
    files : text (optional)
        Comma/space-separated list of TSV/TSV.GZ files uploaded to this session.
        If empty, uses all *.tsv / *.tsv.gz in the session directory.
    locus_field : text
        Column that denotes chain locus (default: 'locus').
    heavy_value : text
        Value denoting heavy locus (default: 'IGH').
    light_values : text
        Comma/space-separated values denoting light loci (default: 'IGK, IGL').
    cell_field : text
        Column with cell identifier (default: 'cell_id') — required in input.
    fallback_from_vcall : select {'true','false'}
        If locus_field is missing, detect heavy via v_call =~ '^IGH' and light via v_call =~ '^IG[KL]'.
        Default true.
    mode : select {'merge','per_file'}
        'merge' → one file SC_no_heavy.tsv; 'per_file' → one file per input (SC_noH_<basename>.tsv).
        In both cases SC_TABLE is set (first produced when per_file).
    sample_field : text
        When merging and non-empty, annotate each row with the filename stem.
    """
    def run(self, sess, sess_dir, params):
        import re
        idx = _next_idx(sess)
        log = sess_dir / f"{idx:03d}_SC_RemoveNoHeavy.log"

        # ---- inputs ----
        files_param = (params.get("files") or "").strip()
        if files_param:
            names = [n for n in re.split(r"[,\s]+", files_param) if n]
        else:
            names = sorted([p.name for p in sess_dir.glob("*.tsv")] +
                           [p.name for p in sess_dir.glob("*.tsv.gz")])
        if not names:
            raise HTTPException(400, "No TSVs found. Upload TSV/TSV.GZ or provide 'files'.")

        for n in names:
            if not (sess_dir / n).exists():
                raise HTTPException(400, f"File not found in session: {n}")

        locus_field = (params.get("locus_field") or "locus").strip() or "locus"
        heavy_value = (params.get("heavy_value") or "IGH").strip() or "IGH"
        light_values_text = (params.get("light_values") or "IGK, IGL").strip()
        light_values = [v for v in re.split(r"[,\s]+", light_values_text) if v]
        cell_field  = (params.get("cell_field")  or "cell_id").strip() or "cell_id"
        fb          = str(params.get("fallback_from_vcall", "true")).lower() in ("1","true","yes","y")
        mode        = (params.get("mode") or "merge").strip().lower()
        if mode not in ("merge","per_file"):
            mode = "merge"
        sfield      = (params.get("sample_field") or "sample_id").strip()

        # ---- R script ----
        rfile = sess_dir / f"{idx:03d}_sc_remove_no_heavy.R"
        out_merged = "SC_no_heavy.tsv"
        # pass: out_merged, mode, sfield, locus_field, heavy_value, light_values (comma-joined), cell_field, fallbackFlag, then files...
        lv_joined = ",".join(light_values)
        r_code = f"""
args <- commandArgs(trailingOnly=TRUE)
out_merged <- args[1]
mode <- args[2]
sfield <- args[3]
locus_field <- {repr(locus_field)}
heavy_value <- {repr(heavy_value)}
light_values <- unlist(strsplit({repr(lv_joined)}, ","))
cell_field <- {repr(cell_field)}
fallbackFlag <- as.logical({str(fb).upper()})
files <- args[-(1:3)]

read_one <- function(f){{
  df <- tryCatch({{
    read.delim(f, header=TRUE, sep="\\t", check.names=FALSE, stringsAsFactors=FALSE)
  }}, error=function(e) {{
    stop(paste("Failed to read:", f, "->", e$message))
  }})
  if (!(cell_field %in% colnames(df))) {{
    stop(paste("Column", cell_field, "not found in", f))
  }}

  # Determine heavy vs light masks
  if (locus_field %in% colnames(df)) {{
    heavy_mask <- df[[locus_field]] == heavy_value
    light_mask <- df[[locus_field]] %in% light_values
  }} else if (fallbackFlag && ("v_call" %in% colnames(df))) {{
    vc <- as.character(df[["v_call"]])
    heavy_mask <- grepl("^IGH", vc)
    light_mask <- grepl("^IG(K|L)", vc)
  }} else {{
    warning(paste("No", locus_field, "and no v_call; cannot classify heavy/light in", f, "-- keeping all rows"))
    return(df)
  }}

  # Cells with only light (no heavy)
  heavy_cells <- unique(df[heavy_mask, cell_field])
  light_cells <- unique(df[light_mask, cell_field])
  no_heavy_cells <- setdiff(light_cells, heavy_cells)

  keep <- !(df[[cell_field]] %in% no_heavy_cells)
  df2 <- df[keep, , drop=FALSE]
  df2
}}

if (mode == "per_file") {{
  for (f in files) {{
    df2 <- read_one(f)
    base <- sub("\\\\.[^.]+$", "", basename(f))
    out <- paste0("SC_noH_", base, ".tsv")
    write.table(df2, file=out, sep="\\t", quote=FALSE, row.names=FALSE)
    cat(paste("Wrote", out, "rows:", nrow(df2), "\\n"))
  }}
}} else {{
  lst <- lapply(files, read_one)
  if (length(lst) == 0) {{
    stop("No input tables after filtering.")
  }}
  merged <- do.call(rbind, lst)
  if (nchar(sfield) > 0) {{
    origins <- unlist(lapply(seq_along(files), function(i){{
      base <- sub("\\\\.[^.]+$", "", basename(files[[i]]))
      n <- nrow(lst[[i]])
      if (n <= 0) return(character(0))
      rep(base, n)
    }}))
    if (length(origins) == nrow(merged)) {{
      merged[[sfield]] <- origins
    }} else {{
      warning("Could not add origin column (row mismatch).")
    }}
  }}
  write.table(merged, file=out_merged, sep="\\t", quote=FALSE, row.names=FALSE)
  cat(paste("Wrote", out_merged, "rows:", nrow(merged), "\\n"))
}}
"""
        rfile.write_text(r_code, encoding="utf-8")

        cmd = ["Rscript", "--vanilla", rfile.name, out_merged, mode, sfield] + names
        run_cmd(cmd, sess_dir, log)

        produced = []
        if mode == "per_file":
            for n in names:
                stem = re.sub(r"\.[^.]+$", "", n)
                out = f"SC_noH_{stem}.tsv"
                if (sess_dir / out).exists():
                    a = Artifact(name=f"SC_NOH_{stem}", path=out, kind="tab", from_step=idx)
                    sess.artifacts[a.name] = a
                    produced.append(a)
            if produced:
                sess.current["SC_TABLE"] = produced[0].name
        else:
            a = Artifact(name="SC_NO_HEAVY", path=out_merged, kind="tab", from_step=idx)
            sess.artifacts[a.name] = a
            produced.append(a)
            sess.current["SC_TABLE"] = a.name

        return StepResult(step_index=idx, unit=self.id, params=params, produced=produced)

# --------- Unit registry (bulk only here) ----------
UNITS: Dict[str, UnitSpec] = {
    "filter_quality": U_FilterQuality(
        id="filter_quality", label="FilterSeq: quality", requires=["R1"], group="bulk",
        params_schema={"qmin":{"type":"int","default":20,"min":0,"max":40}}
    ),
    "filter_length": U_FilterLength(
        id="filter_length", label="FilterSeq: length", requires=["R1"], group="bulk",
        params_schema={"min_len":{"type":"int","default":100,"min":1},"inner":{"type":"select","options":["false","true"],"default":"false"}}
    ),
    "filter_missing": U_FilterMissing(
        id="filter_missing", label="FilterSeq: missing", requires=["R1"], group="bulk",
        params_schema={"max_missing":{"type":"int","default":10,"min":0},"inner":{"type":"select","options":["false","true"],"default":"false"}}
    ),
    "filter_repeats": U_FilterRepeats(
        id="filter_repeats", label="FilterSeq: repeats", requires=["R1"], group="bulk",
        params_schema={"max_repeat":{"type":"text","default":"8"},"missing":{"type":"select","options":["false","true"],"default":"false"},"inner":{"type":"select","options":["false","true"],"default":"false"}}
    ),
    "filter_trimqual": U_FilterTrimQual(
        id="filter_trimqual", label="FilterSeq: trimqual", requires=["R1"], group="bulk",
        params_schema={"qmin":{"type":"int","default":20,"min":0,"max":40},"window":{"type":"int","default":10,"min":1},"reverse":{"type":"select","options":["false","true"],"default":"false"}}
    ),
    "filter_maskqual": U_FilterMaskQual(
        id="filter_maskqual", label="FilterSeq: maskqual", requires=["R1"], group="bulk",
        params_schema={"qmin":{"type":"int","default":20,"min":0,"max":40}}
    ),
    "mask_primers": U_MaskPrimers(
        id="mask_primers", label="MaskPrimers", requires=["R1"], group="bulk",
        params_schema={
            "variant":{"type":"select","options":["align","score","extract"],"default":"align"},
            "mode":{"type":"select","options":["cut","mask","trim","tag"],"default":"mask"},
            "v_primers_fname":{"type":"file","accept":".fa,.fasta","help":"Optional if V primers uploaded in section 1"},
            "c_primers_fname":{"type":"file","accept":".fa,.fasta","optional":True,"help":"Optional if C primers uploaded"},
            "start":{"type":"int","default":0,"min":0},
            "length":{"type":"int","default":30,"min":1},
            "revpr":{"type":"select","options":["false","true"],"default":"false"},
        }
    ),
    "pairseq": U_PairSeq(
        id="pairseq", label="PairSeq", requires=["R1","R2"], group="bulk",
        params_schema={"coord":{"type":"select","options":["illumina","solexa","sra","454","presto"],"default":"illumina"}}
    ),
    "assemble_align": U_AssembleAlign(
        id="assemble_align", label="AssemblePairs: align", requires=["PAIR1","PAIR2"],
        params_schema={
            "coord":{"type":"select","options":["illumina","solexa","sra","454","presto"],"default":"illumina","help":"Coordinate scheme"},
            "rc":{"type":"select","options":["tail","head","both","none"],"default":"tail","help":"Reverse complement policy"},
            "alpha":{"type":"text","placeholder":"e.g. 0.5","help":"Significance threshold (de novo)"},
            "maxerror":{"type":"text","placeholder":"e.g. 0.1","help":"Max error rate (de novo)"},
            "minlen":{"type":"int","default":8,"help":"Min overlap length (de novo)"},
            "maxlen":{"type":"int","default":100,"help":"Max overlap length (de novo)"},
        }
    ),
    "assemble_join": U_AssembleJoin(
        id="assemble_join", label="AssemblePairs: join", requires=["PAIR1","PAIR2"], group="bulk",
        params_schema={
            "coord":{"type":"select","options":["illumina","solexa","sra","454","presto"],"default":"illumina"},
            "rc":{"type":"select","options":["tail","head","both","none"],"default":"tail"},
            "head_fields":{"type":"text","placeholder":"ID,QUAL"},
            "tail_fields":{"type":"text","placeholder":"ID,QUAL"},
            "gap":{"type":"int","default":0}
        }
    ),
    "assemble_sequential": U_AssembleSequential(
        id="assemble_sequential", label="AssemblePairs: sequential", requires=["PAIR1","PAIR2"], group="bulk",
        params_schema={
            "coord":{"type":"select","options":["illumina","solexa","sra","454","presto"],"default":"illumina"},
            "rc":{"type":"select","options":["tail","head","both","none"],"default":"tail"},
            "head_fields":{"type":"text","placeholder":"ID,QUAL"},
            "tail_fields":{"type":"text","placeholder":"ID,QUAL"},
            "alpha":{"type":"text","placeholder":"e.g. 0.5"},
            "maxerror":{"type":"text","placeholder":"e.g. 0.1"},
            "minlen":{"type":"int","default":8},
            "maxlen":{"type":"int","default":100},
            "scanrev":{"type":"select","options":["false","true"],"default":"false"},
            "ref_file":{"type":"text","placeholder":"reference.fasta"},
            "minident":{"type":"text","placeholder":"0.9"},
            "evalue":{"type":"text","placeholder":"1e-4"},
            "maxhits":{"type":"int","default":5},
            "aligner":{"type":"select","options":["blastn","usearch"],"default":"blastn"},
        }
    ),
    "collapse_seq": U_CollapseSeq(
        id="collapse_seq", label="CollapseSeq (deduplicate)", requires=[], group="bulk",
        params_schema={"outname":{"type":"text","default":"COLLAPSE"}, "act":{"type":"select","options":["","min","max","sum","set","majority"],"default":""}}
    ),
    "build_consensus": U_BuildConsensus(
        id="build_consensus", label="BuildConsensus", requires=[], group="bulk",
        params_schema={
            "qmin":{"type":"text","placeholder":"min quality"},
            "freq":{"type":"text","placeholder":"min freq"},
            "maxgap":{"type":"text","placeholder":"0..1"},
            "act":{"type":"text","placeholder":"min,max,sum,set,majority (comma sep)"},
            "dep":{"type":"select","options":["false","true"],"default":"false"},
            "maxdiv":{"type":"text","placeholder":"e.g. 0.05"},
            "maxerror":{"type":"text","placeholder":"e.g. 0.05"},
        }
    ),
     "sc_merge_samples": U_MergeSamples(
        id="sc_merge_samples",
        label="SC: Merge samples (AIRR TSV)",
        requires=[],
        group="sc",
        params_schema={
            "files":{"type":"text","placeholder":"sample1.tsv, sample2.tsv (leave empty = all *.tsv in session)"},
            "aux_types":{"type":"text","placeholder":"v_germline_length=i, d_germline_length=i, j_germline_length=i, day=i"},
            "sample_field":{"type":"text","default":"sample_id","help":"Annotate each row with filename stem; empty to skip"}
        },
    ),
    "sc_filter_productive": U_SC_FilterProductive(
        id="sc_filter_productive",
        label="SC: Keep productive sequences (independent)",
        requires=[],   # <-- no dependency on SC_TABLE
        group="sc",
        params_schema={
            "files": {"type":"text","placeholder":"file1.tsv file2.tsv (blank = all *.tsv/*.tsv.gz)"},
            "productive_field": {"type":"text","default":"productive","help":"Column with TRUE/T/1"},
            "fallback_from_airr": {"type":"select","options":["true","false"],"default":"true",
                                "help":"If 'productive' missing, use (vj_in_frame & !stop_codon)"},
            "mode": {"type":"select","options":["merge","per_file"],"default":"merge"},
            "sample_field": {"type":"text","default":"sample_id","help":"Add origin column when merging"}
        },
    ),
    "sc_remove_multi_heavy": U_SC_RemoveMultiHeavy(
        id="sc_remove_multi_heavy",
        label="SC: Remove cells with multiple heavy chains (independent)",
        requires=[],  # fully independent
        group="sc",
        params_schema={
            "files": {"type":"text","placeholder":"file1.tsv file2.tsv (blank = all *.tsv/*.tsv.gz)"},
            "locus_field": {"type":"text","default":"locus","help":"Column with chain locus (IGH/IGK/IGL)"},
            "heavy_value": {"type":"text","default":"IGH","help":"Value indicating heavy locus"},
            "cell_field": {"type":"text","default":"cell_id","help":"Cell identifier column (required)"},
            "fallback_from_vcall": {"type":"select","options":["true","false"],"default":"true",
                                    "help":"If locus missing, detect heavy via v_call =~ '^IGH'"},
            "mode": {"type":"select","options":["merge","per_file"],"default":"merge"},
            "sample_field": {"type":"text","default":"sample_id","help":"Add origin column when merging"}
        },
    ),
    "sc_remove_no_heavy": U_SC_RemoveNoHeavy(
        id="sc_remove_no_heavy",
        label="SC: Remove cells without heavy chains (independent)",
        requires=[],  # independent
        group="sc",
        params_schema={
            "files": {"type":"text","placeholder":"file1.tsv file2.tsv (blank = all *.tsv/*.tsv.gz)"},
            "locus_field": {"type":"text","default":"locus","help":"Column indicating locus (IGH/IGK/IGL)"},
            "heavy_value": {"type":"text","default":"IGH","help":"Value for heavy locus"},
            "light_values": {"type":"text","default":"IGK, IGL","help":"Values for light loci"},
            "cell_field": {"type":"text","default":"cell_id","help":"Cell identifier column"},
            "fallback_from_vcall": {"type":"select","options":["true","false"],"default":"true",
                                    "help":"If locus missing, infer heavy/light from v_call"},
            "mode": {"type":"select","options":["merge","per_file"],"default":"merge"},
            "sample_field": {"type":"text","default":"sample_id","help":"Add origin column when merging"}
        },
    ),
}

# --------- API ----------
class RunBody(BaseModel):
    unit_id: str
    params: Dict[str, Any] = {}

@app.post("/session/start")
def start_session():
    sid = str(uuid.uuid4())
    sdir = BASE / sid
    sdir.mkdir(parents=True, exist_ok=True)
    save_state(sdir, SessionState(session_id=sid))
    return {"session_id": sid}

@app.get("/session/{sid}/units")
def list_units(sid: str):
    _ = load_state(BASE / sid)

    def _group(u):
        try:
            return u.group
        except Exception:
            # Fallback if any instance lacks 'group'
            return "sc" if (getattr(u, "id", "") or "").startswith("sc_") else "bulk"

    return [
        {
            "id": u.id,
            "label": u.label,
            "requires": u.requires,
            "params_schema": u.params_schema,
            "group": _group(u),
        }
        for u in UNITS.values()
    ]
@app.post("/session/{sid}/upload")
async def upload_reads(sid: str, r1: UploadFile = File(...), r2: Optional[UploadFile] = File(None)):
    sdir = BASE / sid
    sess = load_state(sdir)
    a1 = _save_upload_canonical(r1, "R1", sdir)
    sess.artifacts[a1.name] = a1; sess.current["R1"] = a1.name
    if r2:
        a2 = _save_upload_canonical(r2, "R2", sdir)
        sess.artifacts[a2.name] = a2; sess.current["R2"] = a2.name
    save_state(sdir, sess)
    return {"ok": True, "current": sess.current, "artifacts": list(sess.artifacts.keys())}

def _guess_aux_role(name: str) -> str:
    low = name.lower()
    # very simple heuristics; adjust if needed
    if "vprimer" in low or ("v_" in low and ".fa" in low): return "v_primers"
    if "cprimer" in low or "constant" in low: return "c_primers"
    if low.endswith(".fasta") or low.endswith(".fa"): return "other"
    return "other"

@app.post("/session/{sid}/upload-aux")
async def upload_aux_file(sid: str, file: UploadFile = File(...), name: Optional[str] = Form(None)):
    sdir = BASE / sid
    sess = load_state(sdir)
    fname = name or file.filename
    with open(sdir / fname, "wb") as f:
        shutil.copyfileobj(file.file, f)
    role = _guess_aux_role(fname)
    if role in ("v_primers","c_primers"):
        sess.aux[role] = fname
        save_state(sdir, sess)
    return {"stored_as": fname, "role": role}

@app.post("/session/{sid}/run")
def run_unit(sid: str, body: RunBody = Body(...)):
    sdir = BASE / sid
    sess = load_state(sdir)
    unit = UNITS.get(body.unit_id)
    if not unit:
        raise HTTPException(404, f"Unknown unit_id '{body.unit_id}'")
    # check required channels
    for ch in unit.requires:
        if ch not in sess.current:
            raise HTTPException(400, f"Unit '{unit.id}' requires channel {ch} to be available.")
    step_idx = len(sess.steps)
    try:
        step = unit.run(sess, sdir, body.params)
        sess.steps.append(step)
        save_state(sdir, sess)
        return {"step": step.model_dump(), "current": sess.current, "artifacts": {k:v.model_dump() for k,v in sess.artifacts.items()}}
    except Exception as e:
        prefix = f"{step_idx:03d}_"
        logs = sorted([p for p in sdir.iterdir() if p.name.startswith(prefix) and p.suffix == ".log"])
        tail = ""
        for p in logs:
            try: tail += p.read_text(errors="ignore") + "\n\n"
            except: pass
        if len(tail) > 5000: tail = tail[-5000:]
        raise HTTPException(status_code=500, detail={"error": str(e), "log_tail": tail})

@app.get("/session/{sid}/state")
def get_state(sid: str):
    s = load_state(BASE / sid)
    return s.model_dump()

@app.get("/session/{sid}/download/{artifact_name}")
def download_artifact(sid: str, artifact_name: str):
    sdir = BASE / sid
    s = load_state(sdir)
    a = s.artifacts.get(artifact_name)
    if not a: raise HTTPException(404, "Artifact not found")
    path = sdir / a.path
    if not path.exists(): raise HTTPException(404, "File missing on disk")
    return FileResponse(path, filename=path.name)

@app.get("/session/{sid}/log/{step_index}", response_class=PlainTextResponse)
def get_log(sid: str, step_index: int):
    sdir = BASE / sid
    prefix = f"{int(step_index):03d}_"
    logs = sorted([p for p in sdir.iterdir() if p.name.startswith(prefix) and p.suffix == ".log"])
    if not logs: raise HTTPException(404, "Log not found")
    return "\n\n".join(p.read_text(errors="ignore") for p in logs)

@app.get("/session/{sid}/stats")
def get_pipeline_stats(sid: str):
    """Parse PASS/FAIL statistics from all executed steps in the pipeline."""
    import re
    sdir = BASE / sid
    s = load_state(sdir)
    
    stats = []
    initial_reads = None
    
    # Get all executed steps in order
    if not hasattr(s, 'steps') or not s.steps:
        return {"steps": [], "initial_reads": None}
    
    for step in sorted(s.steps, key=lambda x: x.step_index):
        step_idx = step.step_index
        prefix = f"{step_idx:03d}_"
        logs = sorted([p for p in sdir.iterdir() if p.name.startswith(prefix) and p.suffix == ".log"])
        
        if not logs:
            continue
            
        # Read log content
        log_content = ""
        for log_file in logs:
            try:
                log_content += log_file.read_text(errors="ignore") + "\n"
            except:
                pass
        
        # Parse PASS/FAIL from log (for bulk FilterSeq units)
        # Pattern: "PASS> 23124" or "SEQUENCES> 23124" or "OUTPUT> R1_m10_missing-pass.fastq"
        pass_match = re.search(r'PASS>\s*(\d+)', log_content, re.IGNORECASE)
        fail_match = re.search(r'FAIL>\s*(\d+)', log_content, re.IGNORECASE)
        seq_match = re.search(r'SEQUENCES>\s*(\d+)', log_content, re.IGNORECASE)
        
        # Parse row counts from log (for single-cell units)
        # Pattern: "Wrote SC_productive.tsv rows: 12345" or "rows: 12345"
        rows_match = re.search(r'rows:\s*(\d+)', log_content, re.IGNORECASE)
        
        pass_count = None
        fail_count = None
        input_count = None  # SEQUENCES is the input count
        row_count = None  # For single-cell units
        
        if pass_match:
            pass_count = int(pass_match.group(1))
        if fail_match:
            fail_count = int(fail_match.group(1))
        if seq_match:
            input_count = int(seq_match.group(1))
        if rows_match:
            row_count = int(rows_match.group(1))
        
        # For single-cell units, use row_count as pass_count
        if row_count is not None and pass_count is None:
            pass_count = row_count
        
        # Get initial reads from first step's input (SEQUENCES for bulk, or first row count for SC)
        # For the first step, use its input if available, otherwise use its output as baseline
        if initial_reads is None:
            if input_count is not None:
                initial_reads = input_count
            elif row_count is not None:
                initial_reads = row_count
            elif pass_count is not None:
                # Fallback: if we only have pass count on first step, use it as initial estimate
                initial_reads = pass_count
        
        # Only add stats if we have meaningful data (pass count for filtering steps, or row count for SC)
        if pass_count is not None or row_count is not None:
            unit_obj = UNITS.get(step.unit)
            label = unit_obj.label if unit_obj else step.unit
            # Use pass_count (which may be from row_count for SC units)
            final_pass = pass_count if pass_count is not None else row_count
            stats.append({
                "step_index": step_idx,
                "unit": step.unit,
                "label": label,
                "pass": final_pass,
                "fail": fail_count,
                "input": input_count if input_count else (row_count if row_count and step_idx == 0 else None),  # Input count for this step
                "percentage": round((final_pass / initial_reads * 100), 1) if (final_pass is not None and initial_reads) else None
            })
    
    return {"steps": stats, "initial_reads": initial_reads}
