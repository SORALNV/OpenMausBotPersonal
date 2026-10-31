import json
import sys

print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    value = json.loads(line)
    print(json.dumps({"spans": [[] for _ in value["texts"]]}), flush=True)
