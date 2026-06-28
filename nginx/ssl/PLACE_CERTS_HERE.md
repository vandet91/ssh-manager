# Place your SSL certificate files here

Required files:

- `fullchain.pem` — your certificate + intermediate chain (combined into one file)
- `privkey.pem`   — your private key

## How to combine cert + chain (if provided separately)

```bash
cat yourdomain.crt intermediate.crt root.crt > fullchain.pem
```

Or if your CA gives you a bundle file:

```bash
cat yourdomain.crt ca-bundle.crt > fullchain.pem
```

## File permissions

```bash
chmod 644 fullchain.pem
chmod 600 privkey.pem
```

These files are git-ignored. Never commit them.
