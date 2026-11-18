<?php

/*
 * netdash (network dashboard, https://github.com/Noronus/netdash): register as a service
 * so it shows up in the OPNsense service list with start / stop / restart.
 */

function netdash_services()
{
    $services = [];
    if (file_exists('/usr/local/etc/rc.d/netdash')) {
        $services[] = [
            'description' => gettext('netdash Netzwerk-Dashboard'),
            'configd' => [
                'restart' => ['netdash restart'],
                'start' => ['netdash start'],
                'stop' => ['netdash stop'],
            ],
            'name' => 'netdash',
            'pidfile' => '/var/run/netdash.pid',
        ];
    }
    return $services;
}
