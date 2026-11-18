<?php

/*
 * netdash (https://github.com/Noronus/netdash): menu entry that links to the dashboard,
 * which runs as its own small web server (see /usr/local/etc/netdash.conf).
 */

namespace OPNsense\Netdash;

class IndexController extends \OPNsense\Base\IndexController
{
    public function indexAction()
    {
        $conf = ['port' => 8098, 'tls' => true, 'url' => '', 'listen' => 'lan'];
        $file = '/usr/local/etc/netdash.conf';
        if (is_file($file)) {
            $json = json_decode(file_get_contents($file), true);
            if (is_array($json)) {
                $conf = array_merge($conf, $json);
            }
        }
        $this->view->netdash_url = (string)$conf['url'];
        $this->view->netdash_port = (int)$conf['port'];
        $this->view->netdash_scheme = empty($conf['tls']) ? 'http' : 'https';
        $this->view->netdash_local = ($conf['listen'] === '127.0.0.1');
        $this->view->pick('OPNsense/Netdash/index');
    }
}
