import os, json, urllib.request

token = os.environ['TG_BOT_TOKEN'].strip()
if token.lower().startswith('bot'):
    token = token[3:]
admin_id = 6609386680
base = f'https://api.telegram.org/bot{token}/'

def post(method, payload):
    req = urllib.request.Request(
        base + method,
        data=json.dumps(payload).encode(),
        method='POST',
        headers={'Content-Type': 'application/json', 'User-Agent': 'Minis'}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        print(method, r.read().decode())

post('deleteMyCommands', {'scope': {'type': 'default'}})
post('setMyCommands', {
    'commands': [
        {'command': 'start', 'description': '管理员帮助'},
        {'command': 'help', 'description': '查看用法'},
        {'command': 'users', 'description': '最近用户列表'},
        {'command': 'reply', 'description': '查看回复说明'},
        {'command': 'current', 'description': '当前回复对象'},
        {'command': 'status', 'description': '查看机器人状态'},
        {'command': 'id', 'description': '查看管理员ID'},
    ],
    'scope': {'type': 'chat', 'chat_id': admin_id}
})
