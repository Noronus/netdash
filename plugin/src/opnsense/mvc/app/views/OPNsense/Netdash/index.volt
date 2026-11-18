{#
 # netdash: opens the dashboard (own web server, settings in /usr/local/etc/netdash.conf)
 #}
<div class="content-box" style="padding: 20px;">
    <h2 style="margin-top: 0;">netdash</h2>
    <p>{{ lang._('netdash runs as its own web app. Sign in with an OPNsense administrator account.') }}</p>
{% if netdash_local and netdash_url == '' %}
    <p>{{ lang._('netdash only listens on 127.0.0.1. Set "url" in /usr/local/etc/netdash.conf to the address of your reverse proxy.') }}</p>
{% else %}
    <p><a id="netdash_open" class="btn btn-primary" target="_blank" rel="noopener"><i class="fa fa-external-link fa-fw"></i> {{ lang._('Open netdash') }}</a>
       <span id="netdash_addr" style="margin-left: 10px; font-family: monospace;"></span></p>
{% endif %}
    <p class="text-muted">{{ lang._('Service: System → Diagnostics → Services (netdash). Logs: /var/log/netdash/netdash.log') }}</p>
</div>
<script>
    $(function () {
        var url = "{{ netdash_url|escape_js }}";
        if (url === "") {
            url = "{{ netdash_scheme }}://" + window.location.hostname + ":{{ netdash_port }}/";
        }
        $("#netdash_open").attr("href", url);
        $("#netdash_addr").text(url);
    });
</script>
