#!/usr/bin/env python3
"""Check what `dg … --json` really printed against its JSON Schema (docs/schemas/dg/).

  json_check.py DIR…          check the runs captured in DIR (e2e/cli/dg-json-capture writes
                              them: <n>.args, NUL-separated, <n>.out, stdout, <n>.rc, the exit
                              code); exit 1 when one does not match
  json_check.py --cases PATH… check case files (a file, or every *.json in a directory): one
                              JSON object each, {"args": [...], "exit": 0, "stdout": <text or
                              the parsed object>, "expect": "valid" | "invalid",
                              "command": <the command words, optional>}; exit 1 when a verdict
                              is not the expected one

The exit code says which schema applies: 0, the command's own (index.json `commands`);
anything else, error.schema.json. Commands that print no JSON (`noJson`), a command run
without the flag its JSON needs (`jsonOnlyWith`), and a run that was killed or never
finished are skipped.

Standard library only, so it runs wherever the e2e suite does. It implements the part of
JSON Schema draft 2020-12 that generate.py writes and refuses a schema that uses anything
else, so it cannot pass a document by ignoring a keyword. dg's `json_schemas` unit test
checks the same case files with a full validator and the same expected verdicts.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMAS = os.path.normpath(os.path.join(HERE, '..', '..', 'docs', 'schemas', 'dg'))

# Keywords this validator implements, and the annotations it may ignore.
CHECKED = {'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
           'anyOf', 'oneOf', '$ref', 'pattern'}
IGNORED = {'$schema', '$id', 'title', 'description', '$defs'}
TYPES = {
    'string': lambda v: isinstance(v, str),
    'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
    'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    'boolean': lambda v: isinstance(v, bool),
    'object': lambda v: isinstance(v, dict),
    'array': lambda v: isinstance(v, list),
    'null': lambda v: v is None,
}


class Schemas:
    def __init__(self, root=SCHEMAS):
        self.root = root
        self.files = {}
        self.index = self.load('index.json')

    def load(self, name):
        if name not in self.files:
            with open(os.path.join(self.root, name), encoding='utf-8') as f:
                self.files[name] = json.load(f)
        return self.files[name]

    def resolve(self, ref, base):
        """The schema `ref` names, and the file it is in (`common.schema.json#/$defs/x`, `#/…`)."""
        name, _, pointer = ref.partition('#')
        name = os.path.basename(name) if name else base
        node = self.load(name)
        for part in [p for p in pointer.split('/') if p]:
            node = node[part.replace('~1', '/').replace('~0', '~')]
        return node, name

    def validate(self, value, schema, base, path='$'):
        """Every way `value` does not match `schema` (in file `base`), as `path: why` lines."""
        unknown = set(schema) - CHECKED - IGNORED
        if unknown:
            raise ValueError(f'{base}: keywords json_check.py does not implement: {sorted(unknown)}')
        errors = []
        if '$ref' in schema:
            target, file = self.resolve(schema['$ref'], base)
            errors += self.validate(value, target, file, path)
        if 'type' in schema:
            types = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
            if not any(TYPES[t](value) for t in types):
                return errors + [f'{path}: {short(value)} is not {" or ".join(types)}']
        if 'const' in schema and not same(value, schema['const']):
            errors.append(f'{path}: {short(value)} is not {short(schema["const"])}')
        if 'enum' in schema and not any(same(value, e) for e in schema['enum']):
            errors.append(f'{path}: {short(value)} is not one of {schema["enum"]}')
        if 'pattern' in schema and isinstance(value, str) and not re.search(schema['pattern'], value):
            errors.append(f'{path}: {short(value)} does not match {schema["pattern"]}')
        if isinstance(value, dict):
            props = schema.get('properties', {})
            for key in schema.get('required', []):
                if key not in value:
                    errors.append(f'{path}: `{key}` is missing')
            for key, v in value.items():
                if key in props:
                    errors += self.validate(v, props[key], base, f'{path}.{key}')
                else:
                    extra = schema.get('additionalProperties', True)
                    if extra is False:
                        errors.append(f'{path}: `{key}` is not allowed')
                    elif isinstance(extra, dict):
                        errors += self.validate(v, extra, base, f'{path}.{key}')
        if isinstance(value, list) and 'items' in schema:
            for i, v in enumerate(value):
                errors += self.validate(v, schema['items'], base, f'{path}[{i}]')
        if 'anyOf' in schema:
            tried = [self.validate(value, s, base, path) for s in schema['anyOf']]
            if all(tried):
                errors.append(f'{path}: matches none of anyOf: ' + ' | '.join('; '.join(t) for t in tried))
        if 'oneOf' in schema:
            tried = [self.validate(value, s, base, path) for s in schema['oneOf']]
            matched = sum(1 for t in tried if not t)
            if matched != 1:
                errors.append(f'{path}: matches {matched} of oneOf, not exactly 1: '
                              + ' | '.join('; '.join(t) or 'matches' for t in tried))
        return errors

    def command_of(self, args):
        """The dg command `args` ran (`issue view`): the longest run of words that names one,
        starting at the first word that begins a command (global options come first)."""
        names = set(self.index['commands']) | set(self.index['noJson'])
        firsts = {n.split()[0] for n in names}
        words = []
        for a in args:
            if a == '--':
                break
            words.append(a)
        for i, w in enumerate(words):
            if w.startswith('-') or w not in firsts:
                continue
            best = None
            for j in range(i + 1, len(words) + 1):
                if ' '.join(words[i:j]) in names:
                    best = ' '.join(words[i:j])
            if best:
                return best
        return None

    def check(self, args, exit_code, stdout):
        """('valid' | 'invalid' | 'skipped', the command, why)."""
        command = self.command_of(args)
        if command is None:
            return 'invalid', None, [f'no dg command in {args}']
        if command in self.index['noJson']:
            return 'skipped', command, ['prints no JSON']
        flags = self.index.get('jsonOnlyWith', {}).get(command)
        if flags and not any(a in flags or any(a.startswith(f + '=') for f in flags) for a in args):
            return 'skipped', command, [f'prints JSON only with {" or ".join(flags)}']
        if exit_code is None or exit_code >= 124:
            return 'skipped', command, [f'did not finish (exit {exit_code})']
        if isinstance(stdout, str):
            if not stdout.strip():
                return 'invalid', command, [f'printed nothing on stdout (exit {exit_code})']
            try:
                stdout = json.loads(stdout)
            except ValueError as e:
                return 'invalid', command, [f'stdout is not one JSON document: {e}']
        file = self.index['commands'][command] if exit_code == 0 else self.index['error']
        why = self.validate(stdout, self.load(file), file)
        return ('invalid' if why else 'valid'), command, [f'{file}: {w}' for w in why]


def same(a, b):
    return type(a) is type(b) and a == b or (TYPES['number'](a) and TYPES['number'](b) and a == b)


def short(v):
    text = json.dumps(v, ensure_ascii=False)
    return text if len(text) <= 80 else text[:77] + '…'


def captured(dirs):
    """The runs dg-json-capture recorded: (label, args, exit code, stdout)."""
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith('.args'):
                continue
            stem = os.path.join(d, name[:-5])
            with open(stem + '.args', 'rb') as f:
                args = [a.decode('utf-8', 'replace') for a in f.read().split(b'\0')[:-1]]
            try:
                with open(stem + '.rc', encoding='utf-8') as f:
                    rc = int(f.read().strip())
            except (OSError, ValueError):
                rc = None
            try:
                with open(stem + '.out', encoding='utf-8', errors='replace') as f:
                    out = f.read()
            except OSError:
                out = ''
            yield stem, args, rc, out


def case_files(paths):
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.endswith('.json'):
                    yield os.path.join(p, name)
        else:
            yield p


def main(argv):
    schemas = Schemas(os.environ.get('DG_JSON_SCHEMAS', SCHEMAS))
    failures = checked = skipped = 0
    if argv[:1] == ['--cases']:
        for path in case_files(argv[1:]):
            with open(path, encoding='utf-8') as f:
                case = json.load(f)
            verdict, command, why = schemas.check(case['args'], case['exit'], case['stdout'])
            expect = case.get('expect', 'valid')
            wrong = [] if verdict == expect else [f'expected {expect}, got {verdict}']
            if 'command' in case and case['command'] != command:
                wrong.append(f'read the command as {command!r}, not {case["command"]!r}')
            checked += 1
            if wrong:
                failures += 1
                print(f'FAIL {os.path.basename(path)}: ' + '; '.join(wrong), file=sys.stderr)
                for w in why:
                    print(f'       {w}', file=sys.stderr)
        print(f'json_check: {checked} cases, {failures} with the wrong verdict', file=sys.stderr)
        return 1 if failures else 0
    for label, args, rc, out in captured(argv):
        verdict, command, why = schemas.check(args, rc, out)
        if verdict == 'skipped':
            skipped += 1
            continue
        checked += 1
        if verdict == 'invalid':
            failures += 1
            print(f'json_check: `dg {command or "?"} --json` (exit {rc}) does not match its schema '
                  f'({os.path.basename(label)}.out):', file=sys.stderr)
            for w in why[:20]:
                print(f'    {w}', file=sys.stderr)
    print(f'json_check: {checked} dg --json outputs checked, {skipped} skipped, {failures} not matching '
          f'docs/schemas', file=sys.stderr)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
