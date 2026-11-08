import { configReady, supabase } from './supabase.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const state = { user: null, profile: null, reports: [], matches: [], filter: 'all', search: '', oldest: false, showAll: false, type: 'lost', activeChatId: null, activePair: null, chatChannel: null, boardChannel: null, returnToReport: false, pendingChat: null, aiConfigured: false };

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function initials(value) { return (String(value || 'F').trim()[0] || 'F').toUpperCase(); }
function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function shortDate(value) {
  const d = new Date(`${value}T12:00:00`); if (Number.isNaN(d.getTime())) return value || '';
  const days = Math.round((new Date(`${todayLocal()}T12:00:00`) - d) / 86400000);
  if (days === 0) return 'Today'; if (days === 1) return 'Yesterday'; if (days > 1 && days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function stamp(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2900); }
function dialogOpen(id) { const dialog = document.getElementById(id); if (dialog && !dialog.open) dialog.showModal(); }
function reportImage(path) { return supabase.storage.from('item-photos').getPublicUrl(path).data.publicUrl; }
function throwIfError(result) { if (result.error) throw result.error; return result.data; }

function setAuthMode(mode) {
  const register = mode === 'register';
  $$('.auth-tab').forEach(button => button.classList.toggle('active', button.dataset.authMode === mode));
  $('#authTitle').textContent = register ? 'A good place to start.' : 'Welcome back.';
  $('#authSubtitle').textContent = register ? 'Create your account to post and message.' : 'Sign in to post an item and message the other person.';
  $('#authSubmit').textContent = register ? 'Create my account' : 'Sign in';
  $('#usernameField').hidden = !register; $('#phoneField').hidden = !register;
  $('#authForm [name="username"]').required = register; $('#authForm [name="phone"]').required = register;
  $('#authForm [name="password"]').minLength = register ? 10 : 1;
  $('#authForm [name="password"]').autocomplete = register ? 'new-password' : 'current-password';
  $('#passwordHint').textContent = register ? '10 characters or more' : '';
}
function showAuth(mode = 'login', returnToReport = false) {
  state.returnToReport = returnToReport; setAuthMode(mode); $('#authError').textContent = ''; dialogOpen('authDialog');
}
function setUser(user, profile = null) {
  state.user = user; state.profile = profile;
  $('#authButton').hidden = !!user; $('#profileButton').hidden = !user;
  $('#avatarInitial').textContent = initials(profile?.username || user?.email);
  $('#profileInitial').textContent = initials(profile?.username || user?.email);
  if (user) {
    $('#profileName').textContent = profile?.username || user.email;
    $('#profileEmail').textContent = profile?.email || user.email || '';
    $('#profilePhone').textContent = profile?.phone || 'Private';
  }
}
function updateConnection() {
  const offline = !navigator.onLine;
  $('#offlineRibbon').hidden = !offline;
  $('#aiState').textContent = offline ? 'Offline · shared updates pause' : (state.aiConfigured ? 'Gemini AI · image matching enabled' : 'Online board · connect Gemini to add photo matching');
}
function publicReport(row, profiles) {
  return {
    id: row.id, owner_id: row.owner_id, type: row.type, name: row.name, category: row.category,
    color: row.color, location: row.location, description: row.description,
    image: reportImage(row.image_path), image_path: row.image_path, date: row.report_date,
    status: row.status, created_at: row.created_at, owner_name: profiles.get(row.owner_id)?.username || 'a neighbor',
    is_mine: state.user?.id === row.owner_id,
  };
}

async function refreshData() {
  if (!configReady || !supabase) return;
  const reportResult = await supabase.from('reports')
    .select('id,owner_id,type,name,category,color,location,description,image_path,report_date,status,created_at')
    .eq('status', 'open').order('created_at', { ascending: false }).limit(300);
  if (reportResult.error) { console.error(reportResult.error); toast('Could not load the shared board. Check your online project setup.'); return; }
  const rows = reportResult.data || [];
  const ownerIds = [...new Set(rows.map(row => row.owner_id))];
  let profiles = new Map();
  if (ownerIds.length) {
    const profileResult = await supabase.from('profiles_public').select('id,username').in('id', ownerIds);
    if (!profileResult.error) profiles = new Map((profileResult.data || []).map(profile => [profile.id, profile]));
  }
  state.reports = rows.map(row => publicReport(row, profiles));
  await refreshMatches();
  renderAll();
}

async function refreshMatches() {
  if (!supabase) return;
  const result = await supabase.from('matches').select('lost_report_id,found_report_id,score,reasons,engine,updated_at').order('score', { ascending: false }).limit(100);
  if (result.error) { console.error(result.error); state.matches = []; return; }
  const reports = new Map(state.reports.map(report => [report.id, report]));
  const matchedReports = [...new Set((result.data || []).flatMap(row => [row.lost_report_id, row.found_report_id]))];
  const missingIds = matchedReports.filter(id => !reports.has(id));
  if (missingIds.length) {
    const extra = await supabase.from('reports').select('id,owner_id,type,name,category,color,location,description,image_path,report_date,status,created_at').in('id', missingIds).eq('status', 'open');
    if (!extra.error && extra.data?.length) {
      const ownerIds = [...new Set(extra.data.map(row => row.owner_id))];
      const names = await supabase.from('profiles_public').select('id,username').in('id', ownerIds);
      const profileMap = new Map((names.data || []).map(profile => [profile.id, profile]));
      extra.data.forEach(row => reports.set(row.id, publicReport(row, profileMap)));
    }
  }
  const sharesResult = await supabase.from('phone_shares').select('lost_report_id,found_report_id');
  const shares = new Set((sharesResult.data || []).map(row => `${row.lost_report_id}:${row.found_report_id}`));
  state.matches = (result.data || []).map(row => {
    const lost = reports.get(row.lost_report_id), found = reports.get(row.found_report_id);
    if (!lost || !found) return null;
    return { lost, found, score: row.score, reasons: row.reasons || [], engine: row.engine, phone_shared: shares.has(`${row.lost_report_id}:${row.found_report_id}`), shared_phone: null };
  }).filter(Boolean).filter(match => match.score >= 18);
  if (state.user) {
    const privateNumbers = await Promise.all(state.matches.filter(match => match.lost.is_mine && match.phone_shared).map(async match => {
      const phone = await supabase.rpc('get_shared_found_phone', { p_lost_report_id: match.lost.id, p_found_report_id: match.found.id });
      return { pair: `${match.lost.id}:${match.found.id}`, phone: phone.data };
    }));
    const phoneMap = new Map(privateNumbers.map(row => [row.pair, row.phone]));
    state.matches = state.matches.map(match => ({ ...match, shared_phone: phoneMap.get(`${match.lost.id}:${match.found.id}`) || null }));
  }
}

function reportCard(report) {
  const status = report.type === 'lost' ? 'lost' : 'found';
  return `<article class="report-card"><div class="report-image-wrap"><img class="report-image" src="${esc(report.image)}" alt="${esc(report.type)} ${esc(report.name)}" loading="lazy"><span class="report-status ${status}">${status === 'lost' ? 'Lost item' : 'Found item'}</span><span class="report-category">${esc(report.category)}</span></div>
    <div class="report-content"><div class="report-title-row"><h3>${esc(report.name)}</h3><span class="report-date">${esc(shortDate(report.date))}</span></div><div class="report-place"><span class="pin">⌖</span>${esc(report.location)}</div><p class="report-description">${esc(report.description || `${report.color || report.category} item reported to the community.`)}</p>
    <div class="report-meta"><span class="report-owner"><span class="owner-dot">${esc(initials(report.owner_name))}</span>${report.is_mine ? 'Your listing' : `Posted by ${esc(report.owner_name)}`}</span>${report.is_mine ? `<button class="report-close" data-close-report="${esc(report.id)}">Mark returned</button>` : `<span>${esc(report.color || '')}</span>`}</div></div></article>`;
}

function renderMatches() {
  const grid = $('#matchGrid'), matches = state.matches;
  $('#totalMatches').textContent = matches.length;
  if (!matches.length) {
    grid.innerHTML = `<div class="empty-card"><span class="empty-icon">✦</span><strong>Good matches start with good details.</strong><span>When a lost and found listing share clues, we’ll pair them here with a fit score.</span></div>`;
    return;
  }
  grid.innerHTML = matches.slice(0, 6).map(match => {
    const reasons = Array.isArray(match.reasons) ? match.reasons : [];
    const canMessage = state.user && (match.lost.is_mine || match.found.is_mine);
    const pairLabel = `${match.lost.name} ↔ ${match.found.name}`;
    const call = match.shared_phone && match.lost.is_mine ? `<a class="phone-call" href="tel:${encodeURIComponent(match.shared_phone)}">Call finder ↗</a>` : '';
    return `<article class="match-card"><div class="match-images"><div class="match-photo-wrap"><img class="match-photo" src="${esc(match.lost.image)}" alt="Lost: ${esc(match.lost.name)}" loading="lazy"><span class="match-kind">Lost</span></div><span class="match-bridge" aria-hidden="true">↔</span><div class="match-photo-wrap"><img class="match-photo" src="${esc(match.found.image)}" alt="Found: ${esc(match.found.name)}" loading="lazy"><span class="match-kind found">Found</span></div></div>
      <div class="match-main"><div class="match-pair"><h3 title="${esc(pairLabel)}">${esc(match.lost.name)} <span aria-hidden="true">↔</span> ${esc(match.found.name)}</h3><p>${esc(match.lost.location)} · ${esc(match.found.location)}</p></div><div class="match-score"><strong>${Number(match.score)}%</strong><small>fit score</small></div></div>
      <div class="match-reasons">${esc(reasons.length ? reasons.join(' · ') : 'Similar item details and report timing')}</div><div class="match-actions"><span class="match-engine">✦ ${esc(match.engine || 'Local match')}</span>${call}${canMessage ? `<button class="button button-outline" data-message-lost="${esc(match.lost.id)}" data-message-found="${esc(match.found.id)}">Open private chat ↗</button>` : `<button class="button button-outline" data-auth-message="${esc(match.lost.id)}|${esc(match.found.id)}">Sign in to message ↗</button>`}</div>
    </article>`;
  }).join('');
}

function renderBoard() {
  const query = state.search.toLowerCase();
  let reports = state.reports.filter(report => state.filter === 'all' || report.type === state.filter);
  if (query) reports = reports.filter(report => `${report.name} ${report.category} ${report.color} ${report.location} ${report.description} ${report.owner_name}`.toLowerCase().includes(query));
  reports.sort((a, b) => state.oldest ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at));
  const visible = state.showAll ? reports : reports.slice(0, 6), total = state.reports.length;
  $('#totalReports').textContent = total; $('#reportCountHero').textContent = `${total} ${total === 1 ? 'item' : 'items'}`; $('#filterAllCount').textContent = total;
  $('#pendingArea').innerHTML = '';
  $('#reportGrid').innerHTML = visible.length ? visible.map(reportCard).join('') : `<div class="empty-card"><span class="empty-icon">⌕</span><strong>${query ? 'No listings found.' : 'The board is waiting for its first listing.'}</strong><span>${query ? 'Try another item name or place.' : 'Add a lost or found item to help the community get started.'}</span>${!query ? '<button class="button button-primary button-sm" id="emptyPost">Add the first listing</button>' : ''}</div>`;
  $('#boardSummary').textContent = `${Math.min(visible.length, reports.length)} of ${reports.length} ${reports.length === 1 ? 'listing' : 'listings'} shown`;
  $('#loadMore').hidden = reports.length <= 6; $('#loadMore').textContent = state.showAll ? 'Show fewer listings ↑' : 'Show all listings ↓';
}
function renderAll() { renderMatches(); renderBoard(); }

function openReport() {
  if (!state.user) { showAuth('login', true); return; }
  $('#reportError').textContent = ''; $('#reportForm').reset(); state.type = 'lost'; setReportType('lost');
  $('#reportDate').value = todayLocal(); $('#reportDate').max = todayLocal();
  $('#photoPreview').hidden = true; $('#photoPreview').removeAttribute('src'); $('#photoPlaceholder').hidden = false; $('#removePhoto').hidden = true;
  dialogOpen('reportDialog');
}
function setReportType(type) { state.type = type; $$('.type-option').forEach(button => button.classList.toggle('active', button.dataset.type === type)); $('#reportSubmitLabel').textContent = type === 'lost' ? 'Post lost item' : 'Post found item'; }
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read that photo.')); reader.readAsDataURL(file); }); }
async function compressPhoto(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose a photo file.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a photo under 10 MB.');
  const dataUrl = await fileToDataUrl(file), image = new Image(); image.src = dataUrl;
  await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('That photo could not be opened.')); });
  const scale = Math.min(1, 1300 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  let blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .78));
  if (!blob) throw new Error('Could not prepare that photo.');
  if (blob.size > 1_350_000) blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .58));
  if (!blob || blob.size > 3_500_000) throw new Error('That photo is too large after compression. Try another image.');
  return blob;
}

async function loadProfile(user) {
  if (!user || !supabase) return null;
  const result = await supabase.from('profiles_private').select('id,email,phone,role,created_at').eq('id', user.id).maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}
async function handleAuth(event) {
  event.preventDefault();
  const form = event.currentTarget, mode = $('.auth-tab.active').dataset.authMode, values = Object.fromEntries(new FormData(form).entries());
  const button = $('#authSubmit'); button.disabled = true; $('#authError').textContent = '';
  try {
    let result;
    if (mode === 'register') {
      result = await supabase.auth.signUp({
        email: values.email.trim(), password: values.password,
        options: { data: { username: values.username.trim(), phone: values.phone.trim() }, emailRedirectTo: window.location.origin },
      });
      if (result.error) throw result.error;
      if (!result.data.session) {
        $('#authDialog').close(); form.reset(); state.returnToReport = false;
        toast('Check your email to confirm the new account, then sign in here.'); return;
      }
    } else {
      result = await supabase.auth.signInWithPassword({ email: values.email.trim(), password: values.password });
      if (result.error) throw result.error;
    }
    const user = result.data.user || result.data.session?.user;
    const profile = await loadProfile(user); setUser(user, profile); $('#authDialog').close(); form.reset();
    await refreshData(); toast(mode === 'register' ? 'Your account is ready.' : `Welcome back, ${profile?.email || user.email}.`);
    if (state.returnToReport) { state.returnToReport = false; openReport(); }
    if (state.pendingChat) { const pair = state.pendingChat; state.pendingChat = null; await openChatByIds(pair[0], pair[1]); }
  } catch (error) { $('#authError').textContent = error.message || 'Could not sign in.'; }
  finally { button.disabled = false; }
}

async function postReport(payload) {
  const extension = 'jpg';
  const imagePath = `${state.user.id}/${crypto.randomUUID()}.${extension}`;
  const upload = await supabase.storage.from('item-photos').upload(imagePath, payload.photo, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
  if (upload.error) throw upload.error;
  const inserted = await supabase.from('reports').insert({
    owner_id: state.user.id, type: state.type, name: payload.name, category: payload.category,
    color: payload.color, location: payload.location, description: payload.description,
    image_path: imagePath, report_date: payload.date, status: 'open',
  }).select('id').single();
  if (inserted.error) {
    await supabase.storage.from('item-photos').remove([imagePath]);
    throw inserted.error;
  }
  // The Edge Function verifies ownership, stores local scores immediately, and
  // then enriches the strongest photo pairs with Gemini in the background.
  const matchRequest = supabase.functions.invoke('match-report', { body: { reportId: inserted.data.id } });
  matchRequest.then(({ error, data }) => {
    if (error) { console.warn('Match function:', error.message); toast('Listing is shared. Matching is waiting for backend setup.'); return; }
    state.aiConfigured = Boolean(data?.ai_enabled); updateConnection(); refreshData();
  });
  await refreshData();
  toast('Listing shared across the community. Checking for matches…');
}

async function startChat(match) {
  if (!state.user) { showAuth('login'); return; }
  try {
    const id = await openChatPair(match.lost.id, match.found.id);
    state.activeChatId = id; state.activePair = { lost: match.lost, found: match.found };
    await loadChat(); dialogOpen('chatDialog');
    if (state.chatChannel) await supabase.removeChannel(state.chatChannel);
    state.chatChannel = supabase.channel(`foundly-chat-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `chat_id=eq.${id}` }, () => loadChat(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'phone_shares' }, () => loadChat(false))
      .subscribe();
    setTimeout(() => { $('#chatThread').scrollTop = $('#chatThread').scrollHeight; $('#messageForm [name="body"]').focus(); }, 50);
  } catch (error) { toast(error.message); }
}
async function openChatPair(lostId, foundId) {
  let result = await supabase.from('chats').select('id').eq('lost_report_id', lostId).eq('found_report_id', foundId).maybeSingle();
  if (result.error) throw result.error;
  if (result.data) return result.data.id;
  result = await supabase.from('chats').insert({ lost_report_id: lostId, found_report_id: foundId }).select('id').single();
  if (!result.error) return result.data.id;
  const retry = await supabase.from('chats').select('id').eq('lost_report_id', lostId).eq('found_report_id', foundId).maybeSingle();
  if (retry.data) return retry.data.id;
  throw result.error;
}
async function openChatByIds(lostId, foundId) {
  const match = state.matches.find(item => item.lost.id === lostId && item.found.id === foundId);
  if (match) return startChat(match);
  await refreshData();
  const retry = state.matches.find(item => item.lost.id === lostId && item.found.id === foundId);
  if (retry) return startChat(retry);
  toast('That match is no longer available on the board.');
}
async function loadChat(showError = true) {
  if (!state.activeChatId) return;
  try {
    const chatResult = await supabase.from('chats').select('id,lost_report_id,found_report_id').eq('id', state.activeChatId).single();
    if (chatResult.error) throw chatResult.error;
    const { lost_report_id: lostId, found_report_id: foundId } = chatResult.data;
    const messageResult = await supabase.from('messages').select('sender_id,body,created_at').eq('chat_id', state.activeChatId).order('created_at');
    if (messageResult.error) throw messageResult.error;
    const senderIds = [...new Set((messageResult.data || []).map(message => message.sender_id))];
    const senders = senderIds.length ? await supabase.from('profiles_public').select('id,username').in('id', senderIds) : { data: [] };
    const senderNames = new Map((senders.data || []).map(profile => [profile.id, profile.username]));
    const [lost, found] = await Promise.all([getReport(lostId), getReport(foundId)]);
    const isFinder = found.owner_id === state.user.id;
    const shareResult = await supabase.from('phone_shares').select('lost_report_id').eq('lost_report_id', lostId).eq('found_report_id', foundId).maybeSingle();
    const phoneShared = Boolean(shareResult.data);
    let sharedPhone = null;
    if (!isFinder && phoneShared) {
      const result = await supabase.rpc('get_shared_found_phone', { p_lost_report_id: lostId, p_found_report_id: foundId });
      sharedPhone = result.data || null;
    }
    $('#chatTitle').textContent = `Chat with ${isFinder ? lost.owner_name : found.owner_name}`;
    $('#chatSubtitle').textContent = `${lost.name} · ${found.name}`;
    const thread = $('#chatThread'), messages = messageResult.data || [];
    thread.innerHTML = messages.length ? messages.map(message => `<article class="message ${message.sender_id === state.user.id ? 'mine' : ''}"><p>${esc(message.body)}</p><small>${message.sender_id === state.user.id ? 'You' : esc(senderNames.get(message.sender_id) || 'Neighbor')} · ${esc(stamp(message.created_at))}</small></article>`).join('') : '<div class="chat-empty">Say hello and mention one detail that helps confirm the item. Keep personal details private until you are comfortable sharing them.</div>';
    const share = $('#contactShare');
    if (isFinder) {
      share.innerHTML = phoneShared ? `Your number is shared with the owner of the lost item. <button class="button button-outline" type="button" data-share="false">Revoke access</button>` : `Your phone number is private. Share it with this lost item owner only if you choose. <button class="button button-outline" type="button" data-share="true">Share my number</button>`;
    } else if (phoneShared && sharedPhone) {
      share.innerHTML = `The finder shared their number: <a class="shared-contact" href="tel:${encodeURIComponent(sharedPhone)}">${esc(sharedPhone)} · Call finder</a>`;
    } else share.textContent = 'The finder has not shared a phone number. Keep chatting here to confirm the item.';
    thread.scrollTop = thread.scrollHeight;
  } catch (error) { if (showError) toast(error.message); }
}
async function getReport(id) {
  const cached = state.reports.find(report => report.id === id);
  if (cached) return cached;
  const result = await supabase.from('reports').select('id,owner_id,type,name,category,color,location,description,image_path,report_date,status,created_at').eq('id', id).single();
  if (result.error) throw result.error;
  const names = await supabase.from('profiles_public').select('id,username').eq('id', result.data.owner_id).maybeSingle();
  return publicReport(result.data, new Map(names.data ? [[names.data.id, names.data]] : []));
}
async function submitMessage(event) {
  event.preventDefault(); const input = $('#messageForm [name="body"]'), body = input.value.trim();
  if (!body || !state.activeChatId) return;
  const button = $('#messageForm button'); button.disabled = true;
  try {
    const result = await supabase.from('messages').insert({ chat_id: state.activeChatId, sender_id: state.user.id, body });
    if (result.error) throw result.error;
    input.value = ''; await loadChat(false);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; input.focus(); }
}
async function changePhoneShare(share) {
  const pair = state.activePair;
  if (!pair) return;
  try {
    const result = share
      ? await supabase.from('phone_shares').insert({ lost_report_id: pair.lost.id, found_report_id: pair.found.id, shared_by: state.user.id })
      : await supabase.from('phone_shares').delete().eq('lost_report_id', pair.lost.id).eq('found_report_id', pair.found.id).eq('shared_by', state.user.id);
    if (result.error) throw result.error;
    await loadChat(false); await refreshData(); toast(share ? 'Your phone is shared with this person.' : 'Phone access was removed.');
  } catch (error) { toast(error.message); }
}
async function markReturned(id) {
  const result = await supabase.from('reports').update({ status: 'closed' }).eq('id', id).eq('owner_id', state.user.id);
  if (result.error) { toast(result.error.message); return; }
  await refreshData(); toast('Marked as returned. Thanks for closing the loop.');
}

function bindEvents() {
  $('#authButton').addEventListener('click', () => showAuth('login'));
  $('#profileButton').addEventListener('click', () => dialogOpen('profileDialog'));
  $('#logoutButton').addEventListener('click', async () => { await supabase.auth.signOut(); setUser(null); $('#profileDialog').close(); toast('You are signed out.'); await refreshData(); });
  $('#heroPost').addEventListener('click', openReport); $('#boardPost').addEventListener('click', openReport);
  $('#authForm').addEventListener('submit', handleAuth);
  $$('.auth-tab').forEach(button => button.addEventListener('click', () => { setAuthMode(button.dataset.authMode); $('#authError').textContent = ''; }));
  $$('.type-option').forEach(button => button.addEventListener('click', () => setReportType(button.dataset.type)));
  $('#reportDate').value = todayLocal(); $('#reportDate').max = todayLocal();
  $('#reportPhoto').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { $('#photoPreview').src = await fileToDataUrl(file); $('#photoPreview').hidden = false; $('#photoPlaceholder').hidden = true; $('#removePhoto').hidden = false; }
    catch (error) { $('#reportError').textContent = error.message; }
  });
  $('#removePhoto').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); $('#reportPhoto').value = ''; $('#photoPreview').removeAttribute('src'); $('#photoPreview').hidden = true; $('#photoPlaceholder').hidden = false; $('#removePhoto').hidden = true; });
  $('#reportForm').addEventListener('submit', async event => {
    event.preventDefault(); $('#reportError').textContent = '';
    const form = event.currentTarget, submit = form.querySelector('button[type="submit"]'), data = new FormData(form), file = $('#reportPhoto').files[0];
    if (!file) { $('#reportError').textContent = 'Add one clear photo of the item.'; return; }
    submit.disabled = true; $('#reportSubmitLabel').textContent = 'Preparing listing…';
    try {
      const photo = await compressPhoto(file);
      await postReport({ name: data.get('name').trim(), category: data.get('category'), color: data.get('color').trim(), location: data.get('location').trim(), description: data.get('description').trim(), date: data.get('date'), photo });
      $('#reportDialog').close(); form.reset(); $('#photoPreview').hidden = true; $('#photoPreview').removeAttribute('src'); $('#photoPlaceholder').hidden = false; $('#removePhoto').hidden = true; $('#reportDate').value = todayLocal();
    } catch (error) { $('#reportError').textContent = error.message || 'Could not post the listing.'; }
    finally { submit.disabled = false; $('#reportSubmitLabel').textContent = state.type === 'lost' ? 'Post lost item' : 'Post found item'; }
  });
  $('#searchInput').addEventListener('input', event => { state.search = event.target.value.trim(); state.showAll = false; renderBoard(); });
  $$('.segment').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; state.showAll = false; $$('.segment').forEach(item => item.classList.toggle('active', item === button)); renderBoard(); }));
  $('#sortSelect').addEventListener('change', event => { state.oldest = event.target.value === 'oldest'; renderBoard(); });
  $('#loadMore').addEventListener('click', () => { state.showAll = !state.showAll; renderBoard(); });
  $('#refreshMatches').addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; await refreshData(); button.disabled = false; });
  $('#messageForm').addEventListener('submit', submitMessage);
  $('#chatDialog').addEventListener('close', async () => { state.activeChatId = null; state.activePair = null; if (state.chatChannel) { await supabase.removeChannel(state.chatChannel); state.chatChannel = null; } });
  $$('.modal [data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
  document.addEventListener('click', async event => {
    const target = event.target.closest('[data-message-lost],[data-auth-message],[data-close-report],[data-share],#emptyPost');
    if (!target) return;
    if (target.id === 'emptyPost') { openReport(); return; }
    if (target.hasAttribute('data-message-lost')) {
      const match = state.matches.find(item => item.lost.id === target.dataset.messageLost && item.found.id === target.dataset.messageFound);
      if (match) await startChat(match); return;
    }
    if (target.hasAttribute('data-auth-message')) { state.pendingChat = target.dataset.authMessage.split('|'); showAuth('login'); return; }
    if (target.hasAttribute('data-close-report')) { await markReturned(target.dataset.closeReport); return; }
    if (target.hasAttribute('data-share')) { await changePhoneShare(target.dataset.share === 'true'); }
  });
  window.addEventListener('online', () => { updateConnection(); refreshData(); });
  window.addEventListener('offline', updateConnection);
  if (supabase) {
    state.boardChannel = supabase.channel('foundly-shared-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' }, () => refreshData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, () => refreshData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'phone_shares' }, () => refreshData())
      .subscribe();
  }
}

async function boot() {
  bindEvents();
  if (!configReady || !supabase) {
    $('#aiState').textContent = 'Connect Supabase to start the shared board';
    $('#offlineRibbon').hidden = false;
    $('#offlineRibbon').innerHTML = '<span class="pulse"></span> Add your Supabase URL and publishable key in <code>.env.local</code>, then restart the site.';
    renderAll(); return;
  }
  const session = await supabase.auth.getSession();
  if (session.data.session?.user) {
    try { setUser(session.data.session.user, await loadProfile(session.data.session.user)); }
    catch (error) { console.warn('Profile load:', error.message); setUser(session.data.session.user, null); }
  }
  supabase.auth.onAuthStateChange(async (_event, authSession) => {
    queueMicrotask(async () => {
      if (authSession?.user) {
        try { setUser(authSession.user, await loadProfile(authSession.user)); } catch { setUser(authSession.user, null); }
      } else setUser(null);
    });
  });
  await refreshData(); updateConnection();
}
boot();
