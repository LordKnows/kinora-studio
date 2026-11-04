"""Run the four handoff workflows on a pod at 124 frames (~5 s) to verify them and time a 5 s clip.

Usage: H3_BASE=https://<pod>-8188.proxy.runpod.net python -u verify_handoff.py
Each workflow is used as exported; only `104.length` (and the FL2VA example prompt, which is a template)
are changed. Test images are uploaded under the placeholder names the JSONs reference.
"""
import json, os, subprocess, sys, uuid
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HANDOFF = os.path.dirname(HERE)
RUNPOD = os.path.dirname(os.path.dirname(HANDOFF))
RUN_H3 = os.path.join(RUNPOD, "tools", "run_h3.py")
SH = os.path.join(RUNPOD, "projects", "seventh_heaven")
B = os.environ["H3_BASE"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"

UPLOADS = {
    "first_frame.png": os.path.join(SH, "r4_turbo_chain", "chain_clipA_last.png"),
    "last_frame.png": os.path.join(SH, "r4_turbo_chain", "chain_clipB_last.png"),
    "ref_0.png": os.path.join(SH, "refs", "tifa_sheet_raw.png"),
    "ref_1.png": os.path.join(SH, "refs", "aerith_sheet_raw.png"),
}
FL2VA_PROMPT = (
    "integrated_multimodal_description: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced, "
    "and the target video ends on <Picture 2>.\n\n[Shot 1] Final Fantasy VII Remake cutscene look, high-end real-time 3D render, warm amber practical lighting. "
    "One single continuous take with no cuts that starts exactly on <Picture 1> and ends exactly on <Picture 2>. At the bar counter of Seventh Heaven, "
    "Aerith leans in and whispers into Tifa's ear; Tifa's eyes widen and both burst into giggles, covering their mouths with their hands. "
    "The camera pushes in slowly toward their laughing faces.\n\n"
    "overall_soundscape: Soft mellow jazz from a jukebox, quiet bar room tone, a barely audible whisper, then soft muffled giggles.\n\nnon_diegetic_music: N/A")
ORDER = ["R2VA", "I2VA", "T2VA", "FL2VA"]


def upload(path, name):
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n").encode() + open(path, "rb").read() + \
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    r = urllib.request.Request(B + "/upload/image", data=body, method="POST",
                               headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": UA})
    return json.loads(urllib.request.urlopen(r, timeout=120).read())["name"]


for name, path in UPLOADS.items():
    got = upload(path, name)
    assert got == name, (name, got)
print("uploaded", list(UPLOADS), flush=True)

for mode in ORDER:
    p = json.load(open(os.path.join(HANDOFF, mode + ".json"), encoding="utf-8"))
    p["104"]["inputs"]["length"] = 124
    if mode == "FL2VA":
        p["104"]["inputs"]["prompt"] = FL2VA_PROMPT
    p["92"]["inputs"]["filename_prefix"] = f"video/verify_{mode.lower()}_124"
    wf = f"{mode}_124_workflow_api.json"
    json.dump({"prompt": p, "client_id": "claude-handoff-verify"}, open(os.path.join(HERE, wf), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{mode}: submitting", flush=True)
    with open(os.path.join(HERE, f"{mode}_124_run.log"), "w", encoding="utf-8") as log:
        rc = subprocess.run([sys.executable, "-u", RUN_H3, HERE, HERE, wf], stdout=log, stderr=subprocess.STDOUT).returncode
    print(f"{mode}: run_h3 exited {rc}", flush=True)
