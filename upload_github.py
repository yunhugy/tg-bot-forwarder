import os, sys, json, base64, urllib.request, urllib.error
from pathlib import Path

TOKEN = os.environ.get('GITHUB_TOKEN','')
OWNER = os.environ.get('GITHUB_OWNER','yunhugy')
REPO = os.environ.get('GITHUB_REPO','tg-bot-forwarder')
ROOT = Path('/var/minis/workspace/tg-bot-forwarder')
BRANCH = 'main'

if not TOKEN:
    print('ERR: GITHUB_TOKEN not set')
    sys.exit(1)

headers = {
    'Authorization': f'Bearer {TOKEN}',
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Minis-GitHub-Uploader'
}

def req(method, url, data=None):
    body = None if data is None else json.dumps(data).encode()
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.getcode(), json.loads(resp.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, {'raw': txt}

code, me = req('GET', 'https://api.github.com/user')
if code != 200:
    print('ERR: user auth failed', code)
    sys.exit(1)
owner = me.get('login') or OWNER

code, out = req('POST', 'https://api.github.com/user/repos', {
    'name': REPO,
    'private': True,
    'description': 'Telegram anonymous relay bot for Vercel serverless'
})
if code == 201:
    print(f'REPO_CREATED:{owner}/{REPO}')
elif code == 422:
    print(f'REPO_EXISTS:{owner}/{REPO}')
else:
    print('ERR: create repo failed', code, out)
    sys.exit(1)

skip = {'.git', 'node_modules', '.env', '.vercel', '__pycache__'}
files = []
for p in ROOT.rglob('*'):
    if p.is_dir():
        continue
    rel = p.relative_to(ROOT).as_posix()
    if any(part in skip for part in p.parts):
        continue
    if rel in {'.env'}:
        continue
    files.append(rel)

for rel in sorted(files):
    content = (ROOT / rel).read_bytes()
    b64 = base64.b64encode(content).decode()
    url = f'https://api.github.com/repos/{owner}/{REPO}/contents/{rel}'
    data = {
        'message': f'Add {rel}',
        'content': b64,
        'branch': BRANCH
    }
    code, out = req('PUT', url, data)
    if code not in (200, 201):
        print('ERR: upload failed', rel, code, out)
        sys.exit(1)
    print('UPLOADED', rel)

print(f'REPO_URL:https://github.com/{owner}/{REPO}')
