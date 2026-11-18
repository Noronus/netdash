<?php
/*
 * netdash login check against the OPNsense user database.
 * stdin: {"user": "...", "pass": "..."}  stdout: {"ok": bool, "admin": bool}
 * Runs with cwd /usr/local/opnsense/mvc. Uses the "WebGui" auth service, so the
 * configured GUI authentication servers (local, TOTP, LDAP, ...) apply.
 */
require_once 'script/load_phalcon.php';

$in = json_decode(stream_get_contents(STDIN), true);
$user = is_array($in) ? (string)($in['user'] ?? '') : '';
$pass = is_array($in) ? (string)($in['pass'] ?? '') : '';
$ok = false;
$admin = false;
if ($user !== '' && $pass !== '') {
    $_SERVER['REMOTE_ADDR'] = getenv('NETDASH_CLIENT') ?: 'netdash';
    $ok = (new \OPNsense\Auth\AuthenticationFactory())->authenticate('WebGui', $user, $pass);
    if ($ok) {
        $admin = (new \OPNsense\Core\ACL())->hasPrivilege($user, 'page-all');
    }
}
echo json_encode(['ok' => (bool)$ok, 'admin' => (bool)$admin]), "\n";
