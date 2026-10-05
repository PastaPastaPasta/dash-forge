#!/usr/bin/env python3
"""Inputs of the secret-scan conformance vectors: forge-contracts/vectors/secret_scan/*.json.

    python3 tools/secret-scan-vectors/gen.py            # (re)write the inputs, keep expected
    FORGE_SECRETS_BLESS=1 cargo test -p forge-secrets   # fill in or refresh `expected`

Every fake secret here is obviously fake (FAKE, Forge, NotReal) and still matches its rule. The
file contents are lists of string pieces that a runner joins, split so that no complete token,
key marker or AWS id appears in this repository's bytes (GitHub push protection scans them).
The WIF vectors are Dash Core's public test vectors (src/test/data/key_io_valid.json).

A vector: {name, description, case: "secret_scan", input: {path, content: [pieces] | null,
history, allowFile?, allowSecrets?}, expected: [{rule, line, fingerprint, severity, reason,
allowed}]}. `content: null` means the bytes were not read (a file over the size limit).
"""

import hashlib
import json
import os
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'forge-contracts', 'vectors', 'secret_scan')

B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
B36 = '0123456789abcdefghijklmnopqrstuvwxyz'


def enc(n, alphabet, width):
    s = ''
    while n:
        s = alphabet[n % len(alphabet)] + s
        n //= len(alphabet)
    return s.rjust(width, alphabet[0])


def split(s, at=2):
    """`s` as two pieces, so the whole never appears in this file's output."""
    return [s[:at], s[at:]]


def fingerprint(rule, path, material):
    """The crate's fingerprint, computed independently (crates/forge-secrets/src/lib.rs)."""
    h = hashlib.sha256(b'forge-secrets/v1\0' + rule.encode() + b'\0' + path.encode() + b'\0' + material)
    return h.hexdigest()[:12]


ENV_FP = fingerprint('env_file', '.env', b'DB_PASSWORD=hunter2-not-real\n')


# --- fake secrets ---------------------------------------------------------------------------

GH_PREFIX = 'gh' + 'p_'
GH_RANDOM = 'FakeTokenForForgeSecretsScan01'
assert len(GH_RANDOM) == 30
GH_TOKEN = GH_PREFIX + GH_RANDOM + enc(zlib.crc32(GH_RANDOM.encode()), B62, 6)
GH_BAD = GH_TOKEN[:-1] + ('A' if GH_TOKEN[-1] != 'A' else 'B')
GH_FINE = 'github' + '_pat_' + 'FAKE' + 'x' * 18 + '_' + 'NotRealForgeScan' + 'y' * 43

GL_PREFIX = 'gl' + 'pat-'
GL_PAYLOAD = 'FakeGitLabPayloadForForgeScanTests01'
GL_VER = '01'
GL_LEN = enc(len(GL_PAYLOAD), B36, 2)
GL_CRC = enc(zlib.crc32(f'{GL_PREFIX}{GL_PAYLOAD}.{GL_VER}.{GL_LEN}'.encode()), B36, 7)
GL_TOKEN = f'{GL_PREFIX}{GL_PAYLOAD}.{GL_VER}.{GL_LEN}{GL_CRC}'
GL_LEGACY = GL_PREFIX + 'FakeLegacyNotReal123'

PEM_BEGIN = ['-----BEGIN RSA PRIV', 'ATE KEY-----']
PEM_END = ['-----END RSA PRIV', 'ATE KEY-----']
# base64 of "This is not a real key, it is a Forge test. " repeated.
PEM_LINE = 'VGhpcyBpcyBub3QgYSByZWFsIGtleSwgaXQgaXMgYSBGb3JnZSB0ZXN0LiBUaGlz'
PEM = PEM_BEGIN + ['\n' + PEM_LINE + '\n' + PEM_LINE + '\n'] + PEM_END + ['\n']

AWS_ID = ['AK', 'IAFAKEFAKEFAKEFAKE']
AWS_SECRET = ['Fake', 'SecretKeyForForgeScanTest/NotReal000']
assert len(''.join(AWS_SECRET)) == 40
AWS_DOC_ID = ['AK', 'IAIOSFODNN7EXAMPLE']
AWS_DOC_SECRET = ['wJalrXUtnFEMI/', 'K7MDENG/bPxRfiCYEXAMPLEKEY']

# Dash Core src/test/data/key_io_valid.json: main uncompressed and compressed, testnet, regtest.
DASH_CORE_WIFS = [
    '7sUh9RiHaovsNoNToDz3gfSzbETZBodKCY8ZkLtxbDdcEueuNdd',
    'XK9kG3y8JeDgSNrXdomWiCiBMs7D2eNJSrux1rx7GuGLWpMxEH3w',
    '938BPMAhPitw3MZW9V5UBFVtKwJRkzJGkQuS4EsGiczaHH7Xed6',
    'cRUCRTHRBX9rA9CXDvVEmuPMyRfWNvg8gpMiFiN77wNTJetkFari',
]


def wif_entry(w):
    return ['    ["', w, '", "", {"isPrivkey": true}],\n']


VECTORS = [
    ('env_file_refused', 'A new .env with a value refuses.',
     '.env', ['DB_PASSWORD=hunter2-not-real\n'], {}),
    ('env_local_refused', '.env.local in a subfolder refuses.',
     'app/.env.local', ['# local overrides\nAPI_URL=http://localhost:3000\n'], {}),
    ('env_named_refused', '.env.production refuses.',
     '.env.production', ['export STRIPE_KEY=not-a-real-key\n'], {}),
    ('env_example_passes', '.env.example is a template: no finding.',
     '.env.example', ['DB_PASSWORD=changeme\nAPI_URL=http://localhost:3000\n'], {}),
    ('env_template_passes', '.env.local.template is a template: no finding.',
     'app/.env.local.template', ['DB_PASSWORD=\n'], {}),
    ('env_without_values_passes', 'A .env with comments and empty values only: no finding.',
     '.env', ['# fill these in\nDB_PASSWORD=\nAPI_KEY=""\n'], {}),
    ('env_not_read_refuses_by_name', 'A .env too large to read refuses by its name.',
     'deploy/.env', None, {}),
    ('envrc_warns', 'A .envrc that sets a variable warns.',
     '.envrc', ['use flake\nexport API_URL=https://forge.example\n'], {}),
    ('envrc_without_values_passes', 'A .envrc with no variables: no finding.',
     '.envrc', ['use flake\nlayout python3\n'], {}),
    ('pem_refused', 'A PEM private key outside a test folder refuses.',
     'deploy/server.pem', PEM, {}),
    ('pem_under_test_warns', 'The same key under test/ warns.',
     'test/key.pem', PEM, {}),
    ('pem_under_fixtures_warns', 'A key under a nested fixtures/ folder warns.',
     'crates/tls/fixtures/client.key', PEM, {}),
    ('pem_marker_only_passes', 'Code that mentions the marker holds no key.',
     'src/pem.rs', ['if line.starts_with("', '-----BEGIN RSA PRIV', 'ATE KEY-----', '") {\n    parse(line);\n}\n'], {}),
    ('pem_json_escaped_refused', 'A key inside a JSON string with \\n escapes refuses.',
     'config/service.json',
     ['{"private_key": "'] + PEM_BEGIN + ['\\n' + PEM_LINE + '\\n' + PEM_LINE + '\\n'] + PEM_END + ['\\n"}\n'], {}),
    ('pem_public_key_passes', 'A public key is not a secret.',
     'keys/id.pub', ['-----BEGIN PUB', 'LIC KEY-----\n' + PEM_LINE + '\n' + PEM_LINE + '\n-----END PUB', 'LIC KEY-----\n'], {}),
    ('aws_pair_refused', 'An AWS access key id with its secret refuses.',
     'config/aws.ini',
     ['[default]\naws_access_key_id = '] + AWS_ID + ['\naws_secret_access_key = '] + AWS_SECRET + ['\n'], {}),
    ('aws_pair_shell_refused', 'An AWS pair written NAME=value (shell exports) refuses.',
     'scripts/deploy.sh',
     ['export AWS_ACCESS_KEY_ID='] + AWS_ID + ['\nexport AWS_SECRET_ACCESS_KEY='] + AWS_SECRET + ['\n'], {}),
    ('aws_pair_dockerfile_refused', 'An AWS pair in Dockerfile ENV lines refuses.',
     'Dockerfile',
     ['FROM alpine\nENV AWS_ACCESS_KEY_ID='] + AWS_ID + ['\nENV aws_secret_access_key='] + AWS_SECRET + ['\n'], {}),
    ('aws_id_alone_passes', 'An AWS access key id without a secret does not refuse.',
     'docs/iam.md', ['The deploy role uses key '] + AWS_ID + ['.\n'], {}),
    ('aws_documentation_pair_passes', "AWS's documentation example pair is not a finding.",
     'docs/aws.md', ['id '] + AWS_DOC_ID + ['\nsecret '] + AWS_DOC_SECRET + ['\n'], {}),
    ('github_token_refused', 'A GitHub token with a valid checksum refuses.',
     'scripts/release.sh', ['curl -H "Authorization: token '] + split(GH_TOKEN) + ['" https://api.github.com\n'], {}),
    ('github_token_bad_checksum_warns', 'A GitHub-looking token whose checksum fails only warns.',
     'scripts/release.sh', ['TOKEN='] + split(GH_BAD) + ['\n'], {}),
    ('github_fine_grained_warns', 'A fine-grained token has no published checksum: warns.',
     'ci/env.sh', ['GH='] + split(GH_FINE, 6) + ['\n'], {}),
    ('gitlab_routable_refused', 'A GitLab routable token with a valid checksum refuses.',
     'ci/deploy.yml', ['  token: '] + split(GL_TOKEN) + ['\n'], {}),
    ('gitlab_legacy_warns', 'A legacy glpat- token has no checksum: warns.',
     'ci/deploy.yml', ['  token: '] + split(GL_LEGACY) + ['\n'], {}),
    ('dash_core_wif_vectors_warn', "Dash Core's WIF test vectors warn, never refuse.",
     'src/test/data/key_io_valid.json',
     ['[\n'] + [p for w in DASH_CORE_WIFS for p in wif_entry(w)] + [']\n'], {}),
    ('wif_outside_tests_warns', 'A WIF outside a test folder still only warns.',
     'contrib/seed.py', ['KEY = "', DASH_CORE_WIFS[1], '"\n'], {}),
    ('wif_bad_checksum_passes', 'Base58 of the right length with a bad checksum: no finding.',
     'contrib/seed.py', ['KEY = "', DASH_CORE_WIFS[1][:-1] + 'v', '"\n'], {}),
    ('secret_assignment_warns', 'A random-looking value for a secret-named setting warns.',
     'src/settings.py', ['DEBUG = False\nAPI_TOKEN = "q8Zr2LxP0vNw7TkB4mYcHs9D"\n'], {}),
    ('secret_assignment_placeholder_passes', 'A placeholder value is not a finding.',
     'src/settings.py', ['API_TOKEN = "your_token_goes_here_1234"\n'], {}),
    ('secret_assignment_low_entropy_passes', 'A repetitive value is not a finding.',
     'src/settings.py', ['PASSWORD = "aaaaaaaabbbbbbbbaaaaaaaa"\n'], {}),
    ('history_warns', 'A .env in history (before the import point) warns.',
     '.env', ['DB_PASSWORD=hunter2-not-real\n'], {'history': True}),
    ('allow_file_fingerprint', "The allow file lists the finding's fingerprint.",
     '.env', ['DB_PASSWORD=hunter2-not-real\n'], {'allowFile': ENV_FP + '  # staging, reviewed\n'}),
    ('allow_file_glob', 'The allow file lists the path.',
     'deploy/server.pem', PEM, {'allowFile': '# deploy keys are revoked test keys\ndeploy/*.pem\n'}),
    ('allow_push_option', 'git push -o allow-secret=<fingerprint> allows the finding.',
     '.env', ['DB_PASSWORD=hunter2-not-real\n'], {'allowSecrets': [ENV_FP]}),
    ('binary_file_by_name_only', 'A file with a NUL byte is matched by its name only.',
     'assets/blob.bin', ['\u0000\u0001 TOKEN='] + split(GH_TOKEN) + ['\n'], {}),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, desc, path, content, extra in VECTORS:
        file = os.path.join(OUT, f'secret_scan__{name}.json')
        expected = None
        if os.path.exists(file):
            with open(file) as f:
                expected = json.load(f).get('expected')
        inp = {'path': path, 'content': content, 'history': extra.get('history', False)}
        if 'allowFile' in extra:
            inp['allowFile'] = extra['allowFile']
        if 'allowSecrets' in extra:
            inp['allowSecrets'] = extra['allowSecrets']
        v = {'name': name, 'description': desc, 'case': 'secret_scan', 'input': inp,
             'expected': expected}
        with open(file, 'w') as f:
            json.dump(v, f, indent=2, ensure_ascii=False, sort_keys=True)
            f.write('\n')
    print(f'wrote {len(VECTORS)} vectors to {os.path.relpath(OUT)}')


if __name__ == '__main__':
    main()
