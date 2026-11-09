# TLS test fixture — NOT a secret

`localhost-key.pem` and `localhost-cert.pem` are a self-signed P-256 key and certificate for
`localhost` / `127.0.0.1`, generated for the M139b HTTP/2-over-TLS tests and valid for 100 years.
They protect nothing: no server outside these tests uses them, and the key is public by being
committed. Committed rather than generated at test time because Node cannot mint a certificate, and
an `openssl` call would make the tests skip wherever it is absent.

Regenerate with:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 36500 \
  -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
