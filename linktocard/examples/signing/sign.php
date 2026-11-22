<?php
// Link To Card - reference URL signer for PHP 7.4+ (no dependencies).
//
//   php sign.php [input.json]      input defaults to vector.json next to this file
//
// Copy signed_card_url() into your server-side code. Keep the site secret on
// the server: anyone who has it can create images on your account.

function signed_card_url(string $secret, string $baseUrl, string $siteId, string $template, string $ext, array $params): string
{
    // The signed message is line-based, so line breaks and other control
    // characters are not allowed in values. Replace them before signing.
    $clean = [];
    foreach ($params as $name => $value) {
        $clean[$name] = preg_replace('/[\x00-\x1F\x7F]/', ' ', (string) $value);
    }

    // Signed message, joined with "\n": the path, the sorted parameter names
    // joined with ",", then one "name=value" line per parameter in that order.
    // Values are the plain text, NOT URL-encoded.
    $path = "/v1/og/{$siteId}/{$template}.{$ext}";
    $sorted = $clean;
    ksort($sorted, SORT_STRING);
    $lines = [$path, implode(',', array_keys($sorted))];
    foreach ($sorted as $name => $value) {
        $lines[] = "{$name}={$value}";
    }
    $sig = hash_hmac('sha256', implode("\n", $lines), $secret);

    $query = http_build_query($clean + ['sig' => $sig], '', '&');
    // Optional: PHP writes "*" as %2A, JavaScript leaves it as "*". Both verify
    // (the server signs decoded values); this only makes the URL text identical
    // to the one the JavaScript and Python examples print.
    return $baseUrl . $path . '?' . str_replace('%2A', '*', $query);
}

$file = $argv[1] ?? __DIR__ . '/vector.json';
$input = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
echo signed_card_url(
    $input['secret'],
    $input['base_url'],
    $input['site_id'],
    $input['template'],
    $input['ext'],
    $input['params']
), "\n";
