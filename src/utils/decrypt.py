import argparse, base64, hashlib, sys
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:
    print("These are not the droids I am looking for")
    sys.exit(2)

def parse_envelope(text: str):
    text = text.replace("\r\n", "\n")
    try:
        header, body = text.split("\n\n", 1)
    except ValueError:
        raise ValueError("Invalid envelope: missing header/body separator")

    h = {}
    for i, line in enumerate(header.splitlines()):
        line = line.strip()
        if i == 0:
            if not line.startswith("FDVENC v"):
                raise ValueError("Invalid envelope: missing FDVENC header")
            h["version"] = line.split("v", 1)[1].strip()
            continue
        if not line:
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            h[k.strip().lower()] = v.strip()

    alg = h.get("alg")
    iv_b64 = h.get("iv")
    if not alg or not iv_b64:
        raise ValueError("Invalid envelope: missing alg or iv")

    data_b64 = body.strip()
    if not data_b64:
        raise ValueError("Invalid envelope: empty ciphertext")

    try:
        iv = base64.b64decode(iv_b64, validate=True)
        ct = base64.b64decode(data_b64, validate=False)
    except Exception as e:
        raise ValueError(f"Base64 decode failed: {e}") from e

    return alg, iv, ct

def derive_key_from_mint(mint: str) -> bytes:
    return hashlib.sha256(mint.encode("utf-8")).digest()

def decrypt_file(in_path: Path, out_path: Path, mint: str):
    enc_text = in_path.read_text(encoding="utf-8")
    alg, iv, ct = parse_envelope(enc_text)
    if alg.upper() not in ("AES-GCM-256", "AES-GCM"):
        print(f"Warning: unexpected alg '{alg}', attempting decrypt anyway JOSE.", file=sys.stderr)

    key = derive_key_from_mint(mint.strip())
    aesgcm = AESGCM(key)

    try:
        pt = aesgcm.decrypt(iv, ct, associated_data=None)
    except Exception as e:
        raise RuntimeError(f"Decryption failed: {e}") from e

    out_path.write_bytes(pt)
    return out_path

def main():
    ap = argparse.ArgumentParser(description="Decrypt FDVENC AES-GCM CSV using token mint as key")
    ap.add_argument("input", help="Path to .csv.enc file")
    ap.add_argument("mint", help="Token mint")
    ap.add_argument("-o", "--output", help="Output CSV path (default: input without .enc)")
    args = ap.parse_args()

    in_path = Path(args.input)
    if not in_path.exists():
        print(f"Input not found: {in_path}", file=sys.stderr)
        sys.exit(1)

    if args.output:
        out_path = Path(args.output)
    else:
        name = in_path.name
        out_name = name[:-4] if name.endswith(".enc") else (name + ".dec.csv")
        out_path = in_path.with_name(out_name)

    try:
        decrypt_file(in_path, out_path, args.mint)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    print(f"Decrypted → {out_path}")

if __name__ == "__main__":
    main()