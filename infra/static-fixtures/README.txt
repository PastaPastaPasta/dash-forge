This directory is served by the `static-http` docker-compose service (nginx)
on http://127.0.0.1:8082 for e2e testing of the HTTPS storage backend.

Drop static fixture files (packs, manifests, etc.) here as needed by e2e
suites. This README.txt exists so the directory is non-empty and so a
request to http://127.0.0.1:8082/README.txt has a known-good response to
assert against (status 200, Access-Control-Allow-Origin: *, Accept-Ranges
exposed).
