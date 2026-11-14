# Azure pronunciation assessment test (one-off)

Sends 384 short test clips (22 minutes of audio, en/fr/ar, correct and misread sentences,
synthetic voices, 16 kHz Ogg Opus) to Azure AI Speech pronunciation assessment with the
expected sentence, and prints how many misread words Azure catches and how many correct
words it flags, next to the app's own recognisers on the same clips (out_*.json).
Not part of the app: nothing here runs unless started by hand.

On the VM, after `bash ~/mommy-app/mommy/deploy/oracle/setup.sh`:

    cd ~/mommy-app/mommy
    grep '^AZURE_SPEECH_KEY=' .env | cut -d= -f2- | sudo docker compose run --rm -T --no-deps \
      --entrypoint python -v "$PWD/tools/azure-eval:/eval:ro" mommy \
      /eval/azure_eval.py --key-stdin --region northeurope 2>&1 | tee ~/azure-result.txt

The key goes in on stdin: it is not on the command line, in the output or in any file
the script writes. The free tier takes one request at a time: about 10-15 minutes.
Answers are cached in the container's /tmp only while it runs.
