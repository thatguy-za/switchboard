// A stand-in for the parts of the Proxmox API that WebTerm uses, for the browser tests and for
// trying the Proxmox screens without a Proxmox server. It serves HTTPS with the certificate in
// /tmp/c.pem and /tmp/k.pem, and accepts one token. Start it with tests/ui/run.sh, or see
// tests/ui/README.md to run it by hand.
const https = require('https');
const fs = require('fs');

const TOKEN = 'PVEAPIToken=webterm@pve!power=fake-secret-1234';
const vms = [
  { vmid: 102, name: 'docker-host', node: 'pve1', type: 'qemu', status: 'running', since: Date.now() - 6 * 86400e3, ip: '10.0.0.12' },
  { vmid: 110, name: 'win11-test', node: 'pve1', type: 'qemu', status: 'stopped' },
  { vmid: 120, name: 'nas', node: 'pve1', type: 'qemu', status: 'stopped', ip: '10.0.0.30' },
  { vmid: 200, name: 'pihole', node: 'pve2', type: 'lxc', status: 'running', since: Date.now() - 21 * 86400e3, ip: '10.0.0.2' },
  { vmid: 201, name: 'backup', node: 'pve2', type: 'lxc', status: 'stopped' },
];
const find = (type, id) => vms.find(v => v.type === type && v.vmid === Number(id));
const wait = (ms, fn) => setTimeout(fn, ms);

https.createServer({ key: fs.readFileSync('/tmp/k.pem'), cert: fs.readFileSync('/tmp/c.pem') }, (req, res) => {
  const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data })); };
  if (req.headers.authorization !== TOKEN) return reply(401, null);
  const path = req.url.split('?')[0].replace('/api2/json', '');
  if (path === '/version') return reply(200, { version: '8.2.4' });
  if (path === '/cluster/resources') {
    return reply(200, vms.map(v => ({ vmid: v.vmid, name: v.name, node: v.node, type: v.type, status: v.status, uptime: v.status === 'running' ? Math.floor((Date.now() - v.since) / 1000) : 0 })));
  }
  let m = path.match(/^\/nodes\/[^/]+\/(qemu|lxc)\/(\d+)\/status\/(start|shutdown|reboot|stop)$/);
  if (m && req.method === 'POST') {
    const v = find(m[1], m[2]);
    if (!v) return reply(404, null);
    if (m[3] === 'start') wait(1500, () => { v.status = 'running'; v.since = Date.now(); });
    if (m[3] === 'shutdown') wait(2000, () => { v.status = 'stopped'; });
    if (m[3] === 'stop') v.status = 'stopped';
    if (m[3] === 'reboot') v.since = Date.now();
    return reply(200, 'UPID:fake:' + m[3]);
  }
  m = path.match(/^\/nodes\/[^/]+\/qemu\/(\d+)\/agent\/network-get-interfaces$/);
  if (m) {
    const v = find('qemu', m[1]);
    return v && v.ip ? reply(200, { result: [{ name: 'eth0', 'ip-addresses': [{ 'ip-address': v.ip }] }] }) : reply(500, null);
  }
  m = path.match(/^\/nodes\/[^/]+\/lxc\/(\d+)\/interfaces$/);
  if (m) {
    const v = find('lxc', m[1]);
    return v && v.ip ? reply(200, [{ name: 'eth0', inet: v.ip + '/24' }]) : reply(500, null);
  }
  reply(404, null);
}).listen(8006, () => console.log('fake proxmox on 8006'));
