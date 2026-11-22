"""Link To Card - reference URL signer for Python 3.7+ (standard library only).

    python3 sign.py [input.json]      input defaults to vector.json next to this file

Copy signed_card_url() into your server-side code. Keep the site secret on the
server: anyone who has it can create images on your account.
"""
import hashlib
import hmac
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlencode


def signed_card_url(secret, base_url, site_id, template, ext, params):
    # The signed message is line-based, so line breaks and other control
    # characters are not allowed in values. Replace them before signing.
    clean = {name: re.sub(r"[\x00-\x1f\x7f]", " ", str(value)) for name, value in params.items()}

    # Signed message, joined with "\n": the path, the sorted parameter names
    # joined with ",", then one "name=value" line per parameter in that order.
    # Values are the plain text, NOT URL-encoded.
    path = f"/v1/og/{site_id}/{template}.{ext}"
    names = sorted(clean)
    lines = [path, ",".join(names)] + [f"{name}={clean[name]}" for name in names]
    message = "\n".join(lines).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    # Optional: safe="*" and the "~" replacement only make the URL text identical
    # to the one the JavaScript and PHP examples print. A plain urlencode()
    # verifies just as well, because the server signs decoded values.
    query = urlencode({**clean, "sig": sig}, safe="*").replace("~", "%7E")
    return f"{base_url}{path}?{query}"


if __name__ == "__main__":
    file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("vector.json")
    data = json.loads(file.read_text(encoding="utf-8"))
    print(
        signed_card_url(
            data["secret"],
            data["base_url"],
            data["site_id"],
            data["template"],
            data["ext"],
            data["params"],
        )
    )
