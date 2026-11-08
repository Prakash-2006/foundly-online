import { configReady, supabase } from './supabase.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let adminState = { user: null, users: [], reports: [], counts: {}, channel: null };
function safe(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function toast(message) { const node = $('#adminToast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2900); }
function showLogin(message = '') {
  $('#loginCard').hidden = false; $('#adminDashboard').hidden = true;
  $('#adminFormTitle').textContent = 'Admin sign in.';
  $('#adminFormSubtitle').textContent = message || 'Manage the shared board and view account details.';
  $('#adminLoginForm').hidden = false;
}
function showDashboard(user) {
  adminState.user = user; $('#loginCard').hidden = true; $('#adminDashboard').hidden = false;
  $('#adminName').textContent = user.username; $('#adminInitial').textContent = (user.username || 'A')[0].toUpperCase();
}
async function loadAdminData() {
  const [usersResult, reportsResult] = await Promise.all([
    supabase.from('profiles_private').select('id,email,phone,role,created_at').eq('role', 'user').order('created_at', { ascending: false }),
    supabase.from('reports').select('id,owner_id,type,name,category,color,location,description,image_path,report_date,status,created_at').order('created_at', { ascending: false }).limit(1000),
  ]);
  if (usersResult.error) throw usersResult.error;
  if (reportsResult.error) throw reportsResult.error;
  adminState.users = usersResult.data || []; adminState.reports = reportsResult.data || [];
  const ownerIds = [...new Set([...adminState.reports.map(report => report.owner_id), ...adminState.users.map(user => user.id)])];
  const publicResult = ownerIds.length ? await supabase.from('profiles_public').select('id,username').in('id', ownerIds) : { data: [] };
  if (publicResult.error) throw publicResult.error;
  const publicMap = new Map((publicResult.data || []).map(profile => [profile.id, profile]));
  const privateMap = new Map(adminState.users.map(profile => [profile.id, { ...profile, username: publicMap.get(profile.id)?.username || 'Community member' }]));
  adminState.users = adminState.users.map(profile => privateMap.get(profile.id));
  adminState.reports = adminState.reports.map(report => ({ ...report, username: publicMap.get(report.owner_id)?.username || 'Unknown user', email: privateMap.get(report.owner_id)?.email || '', phone: privateMap.get(report.owner_id)?.phone || '' }));
  const counts = adminState.reports.reduce((acc, report) => { acc[report.status] = (acc[report.status] || 0) + 1; return acc; }, {});
  $('#metricOpen').textContent = counts.open || 0; $('#metricClosed').textContent = counts.closed || 0;
  $('#metricHidden').textContent = counts.hidden || 0; $('#metricUsers').textContent = adminState.users.length;
  $('#tabReportCount').textContent = adminState.reports.length; $('#tabUserCount').textContent = adminState.users.length;
  renderReports(); renderUsers();
}
function subscribeAdminReports() {
  if (adminState.channel) supabase.removeChannel(adminState.channel);
  adminState.channel = supabase.channel('foundly-admin-reports')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' }, () => loadAdminData())
    .subscribe();
}
function reportMarkup(report) {
  const date = new Date(report.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const status = report.status, next = status === 'open' ? 'hidden' : 'open';
  const image = supabase.storage.from('item-photos').getPublicUrl(report.image_path).data.publicUrl;
  return `<tr><td><div class="admin-listing"><img src="${safe(image)}" alt=""><span><strong>${safe(report.name)}</strong><small>${safe(report.type)} · ${safe(report.category)} · ${safe(report.location)}</small></span></div></td><td><div class="admin-owner"><strong>${safe(report.username)}</strong><small>${safe(report.email)}</small><small>${safe(report.phone || 'No phone on account')}</small></div></td><td>${safe(date)}</td><td><span class="admin-status ${safe(status)}">${safe(status)}</span></td><td><div class="admin-actions"><button class="admin-action" data-report-status="${safe(next)}" data-report-id="${safe(report.id)}">Set ${safe(next)}</button><button class="admin-action danger" data-report-delete="${safe(report.id)}">Delete</button></div></td></tr>`;
}
function renderReports() {
  const status = $('#adminStatusFilter').value, query = $('#reportSearch').value.toLowerCase().trim();
  const reports = adminState.reports.filter(report => (status === 'all' || report.status === status) && (!query || `${report.name} ${report.type} ${report.category} ${report.location} ${report.username} ${report.email} ${report.phone}`.toLowerCase().includes(query)));
  $('#adminReports').innerHTML = reports.length ? reports.map(reportMarkup).join('') : '<tr><td colspan="5" class="table-empty">No listings match those filters.</td></tr>';
}
function renderUsers() {
  const query = $('#userSearch').value.toLowerCase().trim();
  const users = adminState.users.filter(user => !query || `${user.username || ''} ${user.email} ${user.phone}`.toLowerCase().includes(query));
  const reportCounts = new Map();
  adminState.reports.forEach(report => reportCounts.set(report.owner_id, (reportCounts.get(report.owner_id) || 0) + 1));
  $('#adminUsers').innerHTML = users.length ? users.map(user => {
    const joined = new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    return `<tr><td><div class="admin-owner"><strong>${safe(user.username || 'Community member')}</strong><small>Account ${safe(user.id.slice(0, 8))}</small></div></td><td>${safe(user.email)}</td><td>${safe(user.phone || '—')}</td><td>${reportCounts.get(user.id) || 0}</td><td>${safe(joined)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="table-empty">No accounts match that search.</td></tr>';
}
async function updateStatus(id, status) {
  const result = await supabase.from('reports').update({ status }).eq('id', id);
  if (result.error) { toast(result.error.message); return; }
  await loadAdminData(); toast(`Listing set to ${status}.`);
}
async function deleteReport(id) {
  if (!confirm('Permanently delete this listing and its photo?')) return;
  const report = adminState.reports.find(item => item.id === id);
  if (!report) return;
  const result = await supabase.from('reports').delete().eq('id', id);
  if (result.error) { toast(result.error.message); return; }
  const photo = await supabase.storage.from('item-photos').remove([report.image_path]);
  if (photo.error) { toast(`Listing removed; photo cleanup failed: ${photo.error.message}`); await loadAdminData(); return; }
  await loadAdminData(); toast('Listing deleted.');
}
function exportUsers() {
  const fields = ['username', 'email', 'phone', 'reports', 'created_at'];
  const counts = new Map(); adminState.reports.forEach(report => counts.set(report.owner_id, (counts.get(report.owner_id) || 0) + 1));
  const quote = value => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const rows = adminState.users.map(user => ({ ...user, username: user.username || 'Community member', reports: counts.get(user.id) || 0 }));
  const csv = [fields.join(','), ...rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'foundly-online-community.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function boot() {
  if (!configReady || !supabase) { showLogin('Add the Supabase URL and publishable key in .env.local before signing in.'); return; }
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      const profileResult = await supabase.from('profiles_private').select('id,email,role').eq('id', session.user.id).maybeSingle();
      if (!profileResult.error && profileResult.data?.role === 'admin') {
        const names = await supabase.from('profiles_public').select('username').eq('id', session.user.id).maybeSingle();
        showDashboard({ ...profileResult.data, username: names.data?.username || profileResult.data.email });
        await loadAdminData(); subscribeAdminReports();
      } else showLogin('This account is not an admin. Sign in with the separate admin account.');
    } else showLogin();
  } catch (error) { showLogin(error.message); }

  $('#adminLoginForm').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('#adminLoginSubmit'); button.disabled = true; $('#loginError').textContent = '';
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const auth = await supabase.auth.signInWithPassword({ email: body.email.trim(), password: body.password });
      if (auth.error) throw auth.error;
      const profile = await supabase.from('profiles_private').select('id,email,role').eq('id', auth.data.user.id).single();
      if (profile.error) throw profile.error;
      if (profile.data.role !== 'admin') {
        await supabase.auth.signOut();
        throw new Error('This account does not have admin access. Use your regular sign-in on the community board.');
      }
      const name = await supabase.from('profiles_public').select('username').eq('id', auth.data.user.id).maybeSingle();
      showDashboard({ ...profile.data, username: name.data?.username || profile.data.email });
      event.currentTarget.reset(); await loadAdminData(); subscribeAdminReports();
    } catch (error) { $('#loginError').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#adminLogout').addEventListener('click', async () => { await supabase.auth.signOut(); showLogin(); toast('Signed out of the admin desk.'); });
  $('#adminRefresh').addEventListener('click', async () => { await loadAdminData(); toast('Admin data refreshed.'); });
  $('#adminStatusFilter').addEventListener('change', renderReports); $('#reportSearch').addEventListener('input', renderReports); $('#userSearch').addEventListener('input', renderUsers);
  $('#exportUsers').addEventListener('click', exportUsers);
  $$('.admin-tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.admin-tab').forEach(item => item.classList.toggle('active', item === tab));
    $$('.admin-view').forEach(view => view.classList.toggle('active', view.id === `${tab.dataset.adminTab}View`));
  }));
  document.addEventListener('click', event => {
    const status = event.target.closest('[data-report-status]'), remove = event.target.closest('[data-report-delete]');
    if (status) updateStatus(status.dataset.reportId, status.dataset.reportStatus);
    if (remove) deleteReport(remove.dataset.reportDelete);
  });
}
boot();
