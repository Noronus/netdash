#!/bin/sh
# Developer deploy over SSH. The normal way to install netdash is the os-netdash package (see README.md).
#   ./deploy.sh           backend + plugin files + frontend, then restart
#   ./deploy.sh backend   backend + plugin files only
#   ./deploy.sh frontend  frontend only (no restart needed)
# Needs OPN_HOST (e.g. root@192.168.1.1) and optionally SSH_KEY, as environment or in an untracked .deploy.env.
set -eu
cd "$(dirname "$0")"
[ -f .deploy.env ] && . ./.deploy.env
: "${OPN_HOST:?set OPN_HOST, e.g. root@192.168.1.1 (or put it into .deploy.env)}"
SSH="ssh ${SSH_KEY:+-i $SSH_KEY} -o ConnectTimeout=8 $OPN_HOST"
D=/usr/local/netdash
what=${1:-all}

if [ "$what" = all ] || [ "$what" = backend ]; then
    python3 -m py_compile backend/*.py
    tar -C backend --exclude __pycache__ -cf - . | $SSH "rm -rf $D/app && mkdir -p $D/app && tar -C $D/app --no-same-owner -xf - && chmod 700 $D"
    tar -C plugin/src -cf - . | $SSH "mkdir -p /tmp/netdash-plugin && tar -C /tmp/netdash-plugin -xf -"
    $SSH sh -s <<'R'
set -e
P=/tmp/netdash-plugin
# a PHP error in plugins.inc.d or the controller would break the OPNsense GUI: lint first
php -l $P/etc/inc/plugins.inc.d/netdash.inc >/dev/null
php -l $P/opnsense/mvc/app/controllers/OPNsense/Netdash/IndexController.php >/dev/null
A=/usr/local/opnsense/service/conf/actions.d/actions_netdash.conf
changed=0
cmp -s $P/opnsense/service/conf/actions.d/actions_netdash.conf $A || changed=1
tar -C $P -cf - . | tar -C /usr/local --no-same-owner -xf -
chmod 755 /usr/local/etc/rc.d/netdash
rm -f /var/lib/php/tmp/opnsense_menu_cache.xml /var/lib/php/tmp/opnsense_acl_cache.json   # new menu entry / ACL
rm -rf $P
[ -f /usr/local/etc/netdash.conf ] || cp /usr/local/etc/netdash.conf.sample /usr/local/etc/netdash.conf
echo 'netdash_enable="YES"' > /etc/rc.conf.d/netdash
[ $changed = 1 ] && service configd restart >/dev/null
true
R
fi

if [ "$what" = all ] || [ "$what" = frontend ]; then
    (cd frontend && npm run build --silent)
    tar -C frontend/dist -cf - . | $SSH "sh -c 'rm -rf $D/www.new $D/www.old && mkdir -p $D/www.new && tar -C $D/www.new --no-same-owner -xf - && if [ -d $D/www ]; then mv $D/www $D/www.old; fi && mv $D/www.new $D/www && rm -rf $D/www.old'"
fi

if [ "$what" = all ] || [ "$what" = backend ]; then
    $SSH "/usr/local/etc/rc.d/netdash stop; /usr/local/etc/rc.d/netdash start; sleep 2; /usr/local/etc/rc.d/netdash status; tail -3 /var/log/netdash/netdash.log"
fi
