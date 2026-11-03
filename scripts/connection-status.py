"""Read-only local and Tailscale serving checks; never edits network rules."""
import json
import os
import subprocess
import urllib.request
import urllib.error


def inspect(env=None, run=subprocess.check_output):
    env = os.environ if env is None else env
    port = env.get('HARNESS_PORT', '8787')
    local = 'http://127.0.0.1:' + port
    active = False
    try:
        with urllib.request.urlopen(local, timeout=2) as response:
            active = b'Distributed Orchestrator' in response.read(8192)
    except urllib.error.HTTPError as e:
        active = e.code == 401
    except OSError:
        pass
    result = {'localUrl': local, 'localStatus': 'Active' if active else 'Offline',
              'phoneUrl': env.get('ORCHESTRATOR_PHONE_URL', ''), 'phoneStatus': 'Tailscale unavailable'}
    try:
        helper = os.path.join(os.path.dirname(__file__), 'network-status.mjs')
        network = json.loads(run(['node', helper], env=env, timeout=30, stderr=subprocess.DEVNULL))
        result['phoneUrl'] = network.get('phoneUrl', '')
        result['phoneStatus'] = (network['message'] if active or not network.get('ready')
                                 else 'Offline — local server stopped')
    except (OSError, ValueError, subprocess.SubprocessError):
        result['phoneStatus'] = 'Connection check failed. Open Settings → Phone access to retry.'
    return result


if __name__ == '__main__':
    print(json.dumps(inspect()))
