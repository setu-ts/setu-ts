# SMTP certificate fixtures

These self-signed test certificates are trusted only inside the TLS name-verification test.
`other-test` has SAN `other.test`; `smtp-x-test` has SAN `smtp.x.test`.

Regenerate the target-name certificate from the repository root:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout packages/mail-plugin/test/fixtures/tls/smtp-x-test.key \
  -out packages/mail-plugin/test/fixtures/tls/smtp-x-test.crt \
  -days 3650 -subj /CN=smtp.x.test -addext subjectAltName=DNS:smtp.x.test
```
