#!/bin/sh
# Temporary dashboard session for browser/API tests on a dev box (user "dev-test", 1 h).
#   tools/testsession.sh create   -> prints token
#   tools/testsession.sh delete
cd "$(dirname "$0")/.."
[ -f .deploy.env ] && . ./.deploy.env
: "${OPN_HOST:?set OPN_HOST, e.g. root@192.168.1.1 (or put it into .deploy.env)}"
SSH="ssh ${SSH_KEY:+-i $SSH_KEY} -o ConnectTimeout=8 $OPN_HOST"
case "$1" in
create) $SSH "/usr/local/bin/python3 -c \"import sqlite3,secrets,time;c=sqlite3.connect('/usr/local/netdash/data/netdash.db');t=secrets.token_urlsafe(24);c.execute('INSERT INTO session VALUES(?,?,?,?,?)',(t,'dev-test',int(time.time()),int(time.time())+3600,'test'));c.commit();print(t)\"" ;;
delete) $SSH "/usr/local/bin/python3 -c \"import sqlite3;c=sqlite3.connect('/usr/local/netdash/data/netdash.db');print(c.execute('DELETE FROM session WHERE user=?',('dev-test',)).rowcount);c.commit()\"" ;;
*) echo "usage: $0 create|delete"; exit 1 ;;
esac
