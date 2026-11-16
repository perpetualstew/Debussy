import json
from pathlib import Path
import re
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


class HomeTests(unittest.TestCase):
    def test_authenticated_fixed_download_surface(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/"library/objects").mkdir(parents=True)
            (root/"library/manifest.json").write_text('{"test":true}')
            process = subprocess.Popen([sys.executable,"-m","perform.home","--resources",str(root),
                "--library",str(root/"library"),"--token-file",str(root/"token"),"--port","0","--no-watch"],
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                ready = selectors.DefaultSelector()
                ready.register(process.stdout, selectors.EVENT_READ)
                self.assertTrue(ready.select(15), "Home service did not start")
                line = process.stdout.readline()
                match = re.search(r"127\.0\.0\.1:(\d+)",line)
                if not match:
                    self.fail("Home service failed: "+process.stderr.read())
                base = "http://127.0.0.1:"+match[1]
                token = (root/"token").read_text()
                with self.assertRaises(urllib.error.HTTPError) as failed:
                    urllib.request.urlopen(base+"/manifest.json")
                self.assertEqual(failed.exception.code,401)
                request = urllib.request.Request(base+"/manifest.json",headers={"Authorization":"Bearer "+token})
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(json.load(response),{"test":True})
                for path in ("/../token","/objects/../../token","/objects/not-a-hash.png"):
                    request = urllib.request.Request(base+path,headers={"Authorization":"Bearer "+token})
                    with self.assertRaises(urllib.error.HTTPError) as failed: urllib.request.urlopen(request)
                    self.assertEqual(failed.exception.code,404)
                self.assertEqual((root/"token").stat().st_mode & 0o777,0o600)
                # Exercise a real Mac render request with an original fixture.
                (root/"UI").mkdir(); (root/"finished").mkdir()
                (root/"UI/finished-pieces.json").write_text('{"pieces":["demo"]}')
                (root/"collection.json").write_text('{"pieces":[{"slug":"demo","title":"Original fixture"}]}')
                score = dict(systems={"s1":dict(width=1000,height=200,first=0,last=0,barlines=[0,1000],
                    svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 200"><path d="M30 100H970" stroke="black"/></svg>')},
                    performance=[dict(systemId="s1",first=0,last=0)])
                (root/"finished/demo.json").write_text(json.dumps(score))
                request = urllib.request.Request(base+"/render",method="POST",headers={"Authorization":"Bearer "+token})
                with urllib.request.urlopen(request) as response: self.assertEqual(response.status,202)
                status = {"running":True}
                for _ in range(100):
                    time.sleep(.1)
                    request = urllib.request.Request(base+"/render",headers={"Authorization":"Bearer "+token})
                    with urllib.request.urlopen(request) as response: status=json.load(response)
                    if not status["running"]: break
                self.assertFalse(status["running"])
                self.assertNotIn("error",status)
                from perform.store import Store
                store=Store(root/"library")
                manifest=store.check(store.load())
                self.assertEqual(len(manifest["profiles"]),16)
                self.assertEqual(set(manifest["pieces"]),{"demo"})
            finally:
                process.terminate()
                process.communicate(timeout=5)


if __name__ == "__main__": unittest.main()
