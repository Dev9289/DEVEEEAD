/* ============================================================
   DEVLO – app.js
   ⚠️  REPLACE the two constants below with your Supabase URL & anon key
   ============================================================ */

const SUPABASE_URL = 'https://vtljruqppapukunviibr.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGpydXFwcGFwdWt1bnZpaWJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyMDk5MDgsImV4cCI6MjA5MTc4NTkwOH0.B7QOPrHgI5NKQ72Hc7a45ZJTuS_5DNfCJplPA_a4X40';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ============================================================
   STATE
   ============================================================ */
let currentUser = null;
let currentUserProfile = null;
let isAdmin = false;
let currentProjectId = null;
let notifSubscription = null;

/* ============================================================
   UTILS
   ============================================================ */
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  el.innerHTML = `<span style="font-size:1rem">${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3500);
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCurrency(amount) {
  if (!amount && amount !== 0) return '—';
  return 'EGP ' + Number(amount).toLocaleString('en-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function countdown(deadline) {
  if (!deadline) return '';
  const diff = new Date(deadline) - new Date();
  const days = Math.ceil(diff / 86400000);
  if (days < 0) return `<span class="countdown overdue">${Math.abs(days)}d overdue</span>`;
  if (days <= 3) return `<span class="countdown soon">${days}d left</span>`;
  return `<span class="countdown ok">${days}d left</span>`;
}

function badge(status) {
  const labels = { pending:'Pending', approved:'Approved', done:'Done', rejected:'Rejected', active:'Active', completed:'Completed', paused:'Paused', cancelled:'Cancelled' };
  return `<span class="badge badge-${status}">${labels[status]||status}</span>`;
}

function priorityBadge(p) {
  const map = { low: '↓ Low', medium: '→ Medium', high: '↑ High' };
  return `<span class="priority-${p}" style="font-size:0.75rem;font-family:var(--font-mono)">${map[p]||p}</span>`;
}

function deadlineClass(deadline) {
  if (!deadline) return '';
  const diff = new Date(deadline) - new Date();
  const days = Math.ceil(diff / 86400000);
  if (days < 0) return 'overdue';
  if (days <= 5) return 'soon';
  return '';
}

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function logActivity(action_type, entity_type, entity_id, description, metadata = {}) {
  try {
    await sb.from('activity_logs').insert({
      user_id: currentUser?.id,
      action_type, entity_type, entity_id, description,
      metadata
    });
  } catch(e) { /* silent */ }
}

async function sendNotification(user_id, title, message, type = 'info', related_type = null, related_id = null) {
  try {
    await sb.from('notifications').insert({ user_id, title, message, type, related_type, related_id });
  } catch(e) { /* silent */ }
}

/* ============================================================
   NAVIGATION / ROUTER
   ============================================================ */
function navigate(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  const page = document.getElementById(`page-${pageId}`);
  if (page) {
    page.classList.add('active');
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(`[data-page="${pageId}"]`).forEach(l => l.classList.add('active'));
  onPageLoad(pageId);
}

function onPageLoad(page) {
  const handlers = {
    home: loadHome,
    portfolio: loadPortfolio,
    dashboard: loadDashboard,
    projects: loadProjects,
    admin: loadAdmin,
    'new-request': setupNewRequest,
    contact: loadContact,
  };
  if (handlers[page]) handlers[page]();
}

// Bind nav clicks
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-page]');
  if (!el) return;
  e.preventDefault();
  const page = el.getAttribute('data-page');

  // Auth guards
  const authPages = ['dashboard', 'projects', 'new-request', 'project-detail'];
  const adminPages = ['admin'];
  if (authPages.includes(page) && !currentUser) { navigate('login'); return; }
  if (adminPages.includes(page) && !isAdmin) { toast('Access denied.', 'error'); return; }
  navigate(page);
});

/* ============================================================
   AUTH STATE
   ============================================================ */
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await onLogin(session.user);
  sb.auth.onAuthStateChange(async (_event, session) => {
    if (session) await onLogin(session.user);
    else onLogout();
  });
}

async function onLogin(user) {
  currentUser = user;
  // Fetch profile — retry once in case the trigger hasn't fired yet
  let profile = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data } = await sb.from('users')
      .select('*, roles(name)')
      .eq('id', user.id)
      .single();
    if (data) { profile = data; break; }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
  }
  // If still no profile, create one with the correct role_id
  if (!profile) {
    // Look up the default 'user' role
    const { data: roleData } = await sb.from('roles').select('id').eq('name', 'user').single();
    await sb.from('users').upsert({
      id: user.id,
      full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'User',
      email: user.email,
      phone: user.user_metadata?.phone || null,
      payment_method: user.user_metadata?.payment_method || null,
      role_id: roleData?.id || null
    }, { onConflict: 'id' });
    const { data } = await sb.from('users').select('*, roles(name)').eq('id', user.id).single();
    profile = data;
  }
  currentUserProfile = profile;
  isAdmin = profile?.roles?.name === 'admin';
  updateAuthUI();
  subscribeNotifications();
  loadNotifCount();
}

function onLogout() {
  currentUser = null; currentUserProfile = null; isAdmin = false;
  if (notifSubscription) { sb.removeChannel(notifSubscription); notifSubscription = null; }
  if (notifPollInterval) { clearInterval(notifPollInterval); notifPollInterval = null; }
  updateAuthUI();
  navigate('home');
}

function updateAuthUI() {
  const show = (sel, visible) => document.querySelectorAll(sel).forEach(el => el.style.display = visible ? '' : 'none');
  if (currentUser) {
    show('.auth-only', true);
    show('.guest-only', false);
    show('.admin-only', isAdmin);
    document.getElementById('dash-greeting').textContent = `Welcome back, ${currentUserProfile?.full_name || 'User'}!`;
  } else {
    show('.auth-only', false);
    show('.guest-only', true);
    show('.admin-only', false);
  }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
  toast('Signed out.', 'info');
});

/* ============================================================
   LOGIN
   ============================================================ */
document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const err = document.getElementById('login-error');
  err.style.display = 'none';
  if (!email || !password) { err.textContent = 'Please fill in all fields.'; err.style.display = 'block'; return; }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
  toast('Welcome back!', 'success');
  navigate('dashboard');
});

/* ============================================================
   REGISTER
   ============================================================ */
document.getElementById('register-btn').addEventListener('click', async () => {
  const full_name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const payment_method = document.getElementById('reg-payment').value;
  const password = document.getElementById('reg-password').value;
  const err = document.getElementById('register-error');
  const btn = document.getElementById('register-btn');
  err.style.display = 'none';

  if (!full_name || !email || !password) { err.textContent = 'Please fill in all required fields.'; err.style.display = 'block'; return; }
  if (password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }

  btn.disabled = true;
  btn.textContent = 'Creating account...';

  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { full_name, phone: phone || null, payment_method: payment_method || null } }
    });

    if (error) { err.textContent = error.message; err.style.display = 'block'; return; }

    const userId = data.user?.id;
    if (userId) {
      // Wait for DB trigger to fire, then upsert to guarantee row exists with all fields
      await new Promise(r => setTimeout(r, 1000));
      const { error: upsertErr } = await sb.from('users').upsert({
        id: userId,
        full_name,
        email,
        phone: phone || null,
        payment_method: payment_method || null
      }, { onConflict: 'id', ignoreDuplicates: false });

      if (upsertErr) {
        // Log but don't block — trigger may have created row already
        console.warn('Profile upsert warning:', upsertErr.message);
      }
    }

    toast('Account created! Check your email to confirm, then sign in.', 'success');
    navigate('login');
  } catch(e) {
    err.textContent = 'Unexpected error. Please try again.';
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});

/* ============================================================
   HOME
   ============================================================ */
async function loadHome() {
  // Load site content
  const { data: content } = await sb.from('site_content').select('key, value');
  if (content) {
    const map = Object.fromEntries(content.map(c => [c.key, c.value]));
    if (map.hero_title) document.getElementById('hero-title').textContent = map.hero_title;
    if (map.hero_subtitle) document.getElementById('hero-sub').textContent = map.hero_subtitle;
    if (map.about_title) document.getElementById('about-title').textContent = map.about_title;
    if (map.about_body) document.getElementById('about-body').textContent = map.about_body;
    if (map.marquee_text) {
      document.getElementById('marquee-track').innerHTML = `<span>${escHtml(map.marquee_text)} &nbsp;&nbsp;&nbsp;</span><span>${escHtml(map.marquee_text)} &nbsp;&nbsp;&nbsp;</span>`;
    }
  }
  // Stats
  const [{ count: projCount }, { count: clientCount }, { count: ticketCount }] = await Promise.all([
    sb.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    sb.from('users').select('id', { count: 'exact', head: true }),
    sb.from('tickets').select('id', { count: 'exact', head: true }).eq('status', 'done'),
  ]);
  animateNum('stat-projects', projCount || 0);
  animateNum('stat-clients', clientCount || 0);
  animateNum('stat-tickets', ticketCount || 0);
}

function animateNum(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  let n = 0; const step = Math.ceil(target / 40);
  const t = setInterval(() => { n = Math.min(n + step, target); el.textContent = n; if (n >= target) clearInterval(t); }, 30);
}

/* ============================================================
   PORTFOLIO
   ============================================================ */
async function loadPortfolio() {
  const grid = document.getElementById('portfolio-grid');
  grid.innerHTML = '<div class="portfolio-loading">Loading…</div>';
  const { data } = await sb.from('portfolio').select('*').eq('is_visible', true).order('display_order');
  if (!data || !data.length) { grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><p>No portfolio items yet.</p></div>'; return; }
  grid.innerHTML = data.map(p => `
    <div class="portfolio-card">
      ${p.image_url ? `<img class="pf-image" src="${escHtml(p.image_url)}" alt="${escHtml(p.title)}" loading="lazy" onerror="this.style.display='none'" />` : `<div class="pf-image-placeholder">🖥</div>`}
      <div class="pf-body">
        <div class="pf-title">${escHtml(p.title)}</div>
        <div class="pf-desc">${escHtml(p.description || '')}</div>
        ${p.tags?.length ? `<div class="pf-tags">${p.tags.map(t => `<span class="pf-tag">${escHtml(t)}</span>`).join('')}</div>` : ''}
        ${p.external_link ? `<a class="pf-link" href="${escHtml(p.external_link)}" target="_blank" rel="noopener">View Project ↗</a>` : ''}
      </div>
    </div>`).join('');
}

/* ============================================================
   NEW REQUEST
   ============================================================ */
function setupNewRequest() {
  const descEl = document.getElementById('req-desc');
  const complexEl = document.getElementById('req-complexity');
  const priceSugg = document.getElementById('price-suggestion');
  const priceDisplay = document.getElementById('suggested-price-display');

  function updateSuggestedPrice() {
    const len = descEl.value.length;
    const c = complexEl.value;
    if (len < 20) { priceSugg.style.display = 'none'; return; }
    const base = 200;
    const lengthF = Math.min(len / 100, 10);
    const complexF = { low: 1.0, medium: 1.5, high: 2.5 }[c] || 1.5;
    const price = Math.round((base + lengthF * 50) * complexF);
    priceDisplay.textContent = `EGP ${price}`;
    priceSugg.style.display = 'block';
  }

  descEl.addEventListener('input', updateSuggestedPrice);
  complexEl.addEventListener('change', updateSuggestedPrice);
}

document.getElementById('submit-request-btn').addEventListener('click', async () => {
  if (!currentUser) { navigate('login'); return; }
  const title = document.getElementById('req-title').value.trim();
  const description = document.getElementById('req-desc').value.trim();
  const deadline = document.getElementById('req-deadline').value;
  const complexity = document.getElementById('req-complexity').value;
  const err = document.getElementById('request-error');
  const btn = document.getElementById('submit-request-btn');
  err.style.display = 'none';
  if (!title || !description) { err.textContent = 'Title and description are required.'; err.style.display = 'block'; return; }

  // Calculate suggested price to store
  const len = description.length;
  const base = 200;
  const lengthF = Math.min(len / 100, 10);
  const complexF = { low: 1.0, medium: 1.5, high: 2.5 }[complexity] || 1.5;
  const suggested_price = Math.round((base + lengthF * 50) * complexF);

  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const { data, error } = await sb.from('requests').insert({
      user_id: currentUser.id, title, description, deadline: deadline || null,
      complexity, status: 'pending', suggested_price
    }).select().single();

    if (error) { err.textContent = error.message; err.style.display = 'block'; return; }

    // Get admin user IDs to notify
    const { data: adminRole } = await sb.from('roles').select('id').eq('name', 'admin').single();
    const { data: admins } = adminRole
      ? await sb.from('users').select('id').eq('role_id', adminRole.id)
      : { data: [] };
    if (admins) {
      for (const admin of admins) {
        await sendNotification(admin.id, 'New Request', `${currentUserProfile?.full_name || 'A user'} submitted a new request: "${title}"`, 'info', 'request', data.id);
      }
    }
    await logActivity('request_created', 'request', data.id, `Request created: ${title}`);

    toast('Request submitted successfully!', 'success');
    document.getElementById('req-title').value = '';
    document.getElementById('req-desc').value = '';
    document.getElementById('req-deadline').value = '';
    document.getElementById('price-suggestion').style.display = 'none';
    navigate('dashboard');
  } catch(e) {
    err.textContent = 'Unexpected error. Please try again.';
    err.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Request →';
  }
});

/* ============================================================
   DASHBOARD
   ============================================================ */
async function loadDashboard() {
  if (!currentUser) return;
  const [reqRes, projRes, ticketRes, meetRes] = await Promise.all([
    sb.from('requests').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id),
    sb.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id),
    sb.from('tickets').select('id', { count: 'exact', head: true }).in('project_id',
      (await sb.from('projects').select('id').eq('user_id', currentUser.id)).data?.map(p=>p.id) || []
    ).not('status', 'eq', 'done'),
    sb.from('meetings').select('id', { count: 'exact', head: true }).in('project_id',
      (await sb.from('projects').select('id').eq('user_id', currentUser.id)).data?.map(p=>p.id) || []
    ).eq('is_completed', false),
  ]);
  document.getElementById('ds-requests').textContent = reqRes.count || 0;
  document.getElementById('ds-projects').textContent = projRes.count || 0;
  document.getElementById('ds-tickets').textContent = ticketRes.count || 0;
  document.getElementById('ds-meetings').textContent = meetRes.count || 0;

  // Recent requests
  const { data: reqs } = await sb.from('requests').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(5);
  const reqList = document.getElementById('recent-requests-list');
  if (!reqs?.length) { reqList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>No requests yet. <a href="#" data-page="new-request" style="color:var(--accent)">Create one →</a></p></div>'; }
  else reqList.innerHTML = reqs.map(r => `
    <div class="request-card" style="margin-bottom:0.75rem">
      <div class="request-card-header">
        <h3>${escHtml(r.title)}</h3>
        ${badge(r.status)}
      </div>
      <p>${escHtml(r.description.substring(0, 120))}${r.description.length > 120 ? '…' : ''}</p>
      <div style="display:flex;gap:1rem;font-size:0.8rem;color:var(--text3)">
        <span>${formatDate(r.created_at)}</span>
        ${r.final_price ? `<span style="color:var(--accent)">EGP ${r.final_price}</span>` : r.suggested_price ? `<span>Est. EGP ${r.suggested_price}</span>` : ''}
      </div>
    </div>`).join('');

  // Recent activity logs
  const { data: logs } = await sb.from('activity_logs').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(8);
  const actList = document.getElementById('recent-activity-list');
  if (!logs?.length) { actList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><p>No activity yet.</p></div>'; }
  else actList.innerHTML = logs.map(l => `
    <div class="log-row">
      <div class="log-icon">📌</div>
      <div class="log-info">
        <div class="log-action">${escHtml(l.description || l.action_type)}</div>
        <div class="log-time">${formatDate(l.created_at)}</div>
      </div>
    </div>`).join('');
}

/* ============================================================
   PROJECTS
   ============================================================ */
async function loadProjects() {
  if (!currentUser) return;
  const { data } = await sb.from('projects').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });
  const list = document.getElementById('projects-list');
  if (!data?.length) { list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🗂</div><p>No projects yet. Submit a request to get started.</p></div>'; return; }
  list.innerHTML = data.map(p => `
    <div class="project-card" onclick="loadProjectDetail('${p.id}')">
      <div class="project-card-info">
        <h3>${escHtml(p.title)}</h3>
        <p>${escHtml((p.description||'').substring(0,100))}${(p.description||'').length>100?'…':''}</p>
      </div>
      <div class="project-card-meta">
        ${p.deadline ? `<span class="deadline-tag ${deadlineClass(p.deadline)}">📅 ${formatDate(p.deadline)}</span>` : ''}
        ${badge(p.status)}
        ${p.price ? `<span style="color:var(--accent);font-family:var(--font-mono);font-size:0.85rem">EGP ${p.price}</span>` : ''}
      </div>
    </div>`).join('');
}

/* ============================================================
   PROJECT DETAIL
   ============================================================ */
async function loadProjectDetail(projectId) {
  currentProjectId = projectId;
  navigate('project-detail');
  const el = document.getElementById('project-detail-content');
  el.innerHTML = '<div style="padding:3rem;text-align:center;color:var(--text3)">Loading…</div>';

  const [{ data: proj }, { data: tickets }, { data: meetings }] = await Promise.all([
    sb.from('projects').select('*').eq('id', projectId).single(),
    sb.from('tickets').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
    sb.from('meetings').select('*').eq('project_id', projectId).order('scheduled_at'),
  ]);

  if (!proj) { el.innerHTML = '<div class="empty-state">Project not found.</div>'; return; }

  const ticketHtml = tickets?.length ? tickets.map(t => `
    <div class="ticket-card" onclick="openTicketDetail('${t.id}')">
      <div class="ticket-card-header">
        <div class="ticket-title">${escHtml(t.title)}</div>
        <div class="ticket-badges">${badge(t.status)} ${priorityBadge(t.priority)}</div>
      </div>
      <div class="ticket-desc">${escHtml((t.description||'').substring(0,100))}${(t.description||'').length>100?'…':''}</div>
      <div class="ticket-footer">
        <span>Created ${formatDate(t.created_at)}</span>
        ${t.deadline ? countdown(t.deadline) : ''}
      </div>
    </div>`).join('') : '<div class="empty-state"><div class="empty-state-icon">🎫</div><p>No tickets yet.</p></div>';

  const meetingHtml = meetings?.length ? meetings.map(m => `
    <div class="meeting-item">
      <span class="${m.is_completed ? 'completed' : ''}">${escHtml(m.title)}</span>
      <span>${m.is_completed ? badge('done') : badge('pending')}</span>
    </div>`).join('') : '<div style="color:var(--text3);font-size:0.85rem;padding:0.5rem 0">No meetings yet.</div>';

  el.innerHTML = `
    <div class="project-detail">
      <div style="margin-bottom:1rem">
        <button class="btn-ghost btn-sm" onclick="navigate('projects')">← Back to Projects</button>
      </div>
      <div class="project-detail-header">
        <div>
          <div class="project-detail-title">${escHtml(proj.title)}</div>
          <div class="project-meta-row">
            ${badge(proj.status)}
            ${proj.deadline ? `<span class="project-meta-item">📅 Deadline: ${formatDate(proj.deadline)} ${countdown(proj.deadline)}</span>` : ''}
            ${proj.price ? `<span class="project-meta-item" style="color:var(--accent)">💰 EGP ${proj.price} ${proj.is_paid ? badge('done') : badge('pending')}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="project-detail-grid">
        <div class="tickets-section">
          <div class="tickets-header">
            <h2>Tickets</h2>
            <button class="btn-primary btn-sm" onclick="openNewTicketModal('${proj.id}')">+ New Ticket</button>
          </div>
          <div class="tickets-list">${ticketHtml}</div>
        </div>
        <div class="project-sidebar">
          <div class="sidebar-card">
            <h3>Project Info</h3>
            <div class="sidebar-row"><span>Status</span><span>${badge(proj.status)}</span></div>
            <div class="sidebar-row"><span>Deadline</span><span>${formatDate(proj.deadline)}</span></div>
            <div class="sidebar-row"><span>Price</span><span>${proj.price ? formatCurrency(proj.price) : 'TBD'}</span></div>
            <div class="sidebar-row"><span>Payment</span><span>${proj.is_paid ? '<span style="color:var(--green)">Paid</span>' : '<span style="color:var(--yellow)">Unpaid</span>'}</span></div>
            <div class="sidebar-row"><span>Max Tickets</span><span>${proj.max_tickets}</span></div>
            <div class="sidebar-row"><span>Tickets Used</span><span>${tickets?.length || 0}</span></div>
          </div>
          <div class="sidebar-card">
            <h3>Meetings</h3>
            <div class="sidebar-row" style="margin-bottom:0.75rem"><span>Total</span><span>${proj.max_meetings}</span></div>
            <div class="sidebar-row" style="margin-bottom:0.75rem"><span>Completed</span><span style="color:var(--green)">${meetings?.filter(m=>m.is_completed).length||0}</span></div>
            <div class="sidebar-row" style="margin-bottom:0.75rem"><span>Remaining</span><span style="color:var(--accent)">${proj.max_meetings - (meetings?.filter(m=>m.is_completed).length||0)}</span></div>
            <div class="meetings-list">${meetingHtml}</div>
            ${!isAdmin ? `<button class="btn-ghost btn-sm" style="width:100%;margin-top:0.75rem" onclick="openMeetingRequestModal('${proj.id}')">📅 Request a Meeting</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   TICKET MODALS
   ============================================================ */
function openNewTicketModal(projectId) {
  showModal(`
    <h2>New Ticket</h2>
    <div id="ticket-err" class="form-error" style="display:none"></div>
    <div class="form-group"><label>Title</label><input type="text" id="tk-title" placeholder="Brief description" /></div>
    <div class="form-group"><label>Description</label><textarea id="tk-desc" rows="4" placeholder="Detailed description of the request or issue…"></textarea></div>
    <div class="form-row">
      <div class="form-group"><label>Priority</label>
        <select id="tk-priority">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div class="form-group"><label>Deadline</label><input type="date" id="tk-deadline" /></div>
    </div>
    <div class="form-group">
      <label>Attachments</label>
      <div class="file-drop-zone" id="file-drop" onclick="document.getElementById('file-input').click()">
        <p>Click or drag files here to upload</p>
        <input type="file" id="file-input" multiple style="display:none" />
      </div>
      <div class="file-list" id="file-preview"></div>
    </div>
    <button class="btn-primary full" onclick="submitNewTicket('${projectId}')">Submit Ticket</button>
  `);
  setupFileDrop();
}

let pendingFiles = [];
function setupFileDrop() {
  pendingFiles = [];
  const zone = document.getElementById('file-drop');
  const input = document.getElementById('file-input');
  const preview = document.getElementById('file-preview');

  function addFiles(files) {
    Array.from(files).forEach(f => {
      if (!pendingFiles.find(pf => pf.name === f.name)) {
        pendingFiles.push(f);
        const div = document.createElement('div');
        div.className = 'file-item';
        div.dataset.name = f.name;
        div.innerHTML = `<span class="file-item-name">📎 ${escHtml(f.name)}</span><button class="file-item-remove" onclick="removeFile('${escHtml(f.name)}')">×</button>`;
        preview.appendChild(div);
      }
    });
  }

  input.addEventListener('change', e => addFiles(e.target.files));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); addFiles(e.dataTransfer.files); });
}

window.removeFile = function(name) {
  pendingFiles = pendingFiles.filter(f => f.name !== name);
  const el = document.querySelector(`.file-item[data-name="${CSS.escape(name)}"]`);
  if (el) el.remove();
};

window.submitNewTicket = async function(projectId) {
  const title = document.getElementById('tk-title').value.trim();
  const description = document.getElementById('tk-desc').value.trim();
  const priority = document.getElementById('tk-priority').value;
  const deadline = document.getElementById('tk-deadline').value;
  const err = document.getElementById('ticket-err');
  const submitBtn = document.querySelector('#modal-content .btn-primary.full');
  err.style.display = 'none';

  if (!title || !description) { err.textContent = 'Title and description required.'; err.style.display = 'block'; return; }

  // Disable button to prevent double-submit
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

  try {
    // Check max tickets
    const { count } = await sb.from('tickets').select('id', { count: 'exact', head: true }).eq('project_id', projectId);
    const { data: proj } = await sb.from('projects').select('max_tickets').eq('id', projectId).single();
    if (count >= (proj?.max_tickets || 10)) {
      err.textContent = `Max tickets limit (${proj?.max_tickets || 10}) reached.`;
      err.style.display = 'block';
      return;
    }

    const { data: ticket, error } = await sb.from('tickets').insert({
      project_id: projectId, created_by: currentUser.id,
      title, description, priority, deadline: deadline || null, status: 'pending'
    }).select().single();

    if (error) { err.textContent = error.message; err.style.display = 'block'; return; }

    // Upload files (non-blocking — skip file if storage bucket not set up)
    for (const file of pendingFiles) {
      try {
        const path = `${currentUser.id}/${ticket.id}/${Date.now()}_${file.name}`;
        const { data: fileData } = await sb.storage.from('ticket-files').upload(path, file, { upsert: true });
        if (fileData) {
          const { data: signedData } = await sb.storage.from('ticket-files').createSignedUrl(path, 60 * 60 * 24 * 365);
          const fileUrl = signedData?.signedUrl || path;
          await sb.from('ticket_files').insert({
            ticket_id: ticket.id, uploaded_by: currentUser.id,
            file_name: file.name, file_url: fileUrl,
            file_type: file.type, file_size: file.size
          });
        }
      } catch(fileErr) {
        console.warn('File upload skipped:', file.name, fileErr);
      }
    }

    // Notify admins
    try {
      const { data: adminRole } = await sb.from('roles').select('id').eq('name', 'admin').single();
      const { data: admins } = adminRole
        ? await sb.from('users').select('id').eq('role_id', adminRole.id)
        : { data: [] };
      if (admins) {
        for (const admin of admins) {
          await sendNotification(admin.id, 'New Ticket', `New ticket: "${title}"`, 'info', 'ticket', ticket.id);
        }
      }
    } catch(notifErr) { /* silent */ }

    await logActivity('ticket_created', 'ticket', ticket.id, `Ticket created: ${title}`);

    closeModal();
    toast('Ticket submitted!', 'success');
    loadProjectDetail(projectId);

  } catch(e) {
    err.textContent = 'Unexpected error: ' + (e.message || 'Please try again.');
    err.style.display = 'block';
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Ticket'; }
  }
}

async function openTicketDetail(ticketId) {
  const { data: t } = await sb.from('tickets').select('*').eq('id', ticketId).single();
  const { data: files } = await sb.from('ticket_files').select('*').eq('ticket_id', ticketId);
  if (!t) return;

  const filesHtml = files?.length ? files.map(f => `
    <a href="${escHtml(f.file_url)}" target="_blank" class="file-item" style="text-decoration:none">
      <span class="file-item-name">📎 ${escHtml(f.file_name)}</span>
      <span style="font-size:0.7rem;color:var(--text3)">${f.file_size ? Math.round(f.file_size/1024)+'KB' : ''}</span>
    </a>`).join('') : '<p style="color:var(--text3);font-size:0.85rem">No attachments.</p>';

  const adminControls = isAdmin ? `
    <div style="border-top:1px solid var(--border);padding-top:1.25rem;margin-top:1.25rem">
      <h3 style="font-family:var(--font-display);font-size:1rem;margin-bottom:1rem">Admin Controls</h3>
      <div class="form-row" style="margin-bottom:1rem">
        <div class="form-group">
          <label>Status</label>
          <select id="tk-admin-status" onchange="updateTicketStatus('${t.id}', this.value)">
            <option value="pending" ${t.status==='pending'?'selected':''}>Pending</option>
            <option value="approved" ${t.status==='approved'?'selected':''}>Approved</option>
            <option value="done" ${t.status==='done'?'selected':''}>Done</option>
            <option value="rejected" ${t.status==='rejected'?'selected':''}>Rejected</option>
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select id="tk-admin-priority" onchange="updateTicketPriority('${t.id}', this.value)">
            <option value="low" ${t.priority==='low'?'selected':''}>Low</option>
            <option value="medium" ${t.priority==='medium'?'selected':''}>Medium</option>
            <option value="high" ${t.priority==='high'?'selected':''}>High</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Admin Notes</label>
        <textarea id="tk-admin-notes" rows="2">${escHtml(t.admin_notes||'')}</textarea>
      </div>
      <button class="btn-primary btn-sm" onclick="saveAdminNotes('${t.id}')">Save Notes</button>
    </div>` : '';

  showModal(`
    <h2>${escHtml(t.title)}</h2>
    <div style="display:flex;gap:0.75rem;margin-bottom:1.25rem;flex-wrap:wrap">
      ${badge(t.status)} ${priorityBadge(t.priority)}
      ${t.deadline ? countdown(t.deadline) : ''}
    </div>
    <div class="form-group"><label>Description</label><p style="color:var(--text2);line-height:1.7;font-size:0.9rem">${escHtml(t.description)}</p></div>
    <div class="form-group"><label>Attachments</label><div class="file-list">${filesHtml}</div></div>
    <div style="display:flex;gap:1.5rem;font-size:0.8rem;color:var(--text3)">
      <span>Created: ${formatDate(t.created_at)}</span>
      ${t.deadline ? `<span>Deadline: ${formatDate(t.deadline)}</span>` : ''}
    </div>
    ${adminControls}
  `);
}

window.updateTicketStatus = async function(ticketId, status) {
  await sb.from('tickets').update({ status }).eq('id', ticketId);
  // Get ticket + project info for notification
  const { data: ticket } = await sb.from('tickets').select('*, projects(user_id)').eq('id', ticketId).single();
  if (ticket?.projects?.user_id) {
    await sendNotification(ticket.projects.user_id, 'Ticket Updated', `Your ticket "${ticket.title}" is now ${status}.`, 'info', 'ticket', ticketId);
  }
  await logActivity('ticket_status_changed', 'ticket', ticketId, `Ticket status changed to ${status}`);
  toast('Status updated!', 'success');
  if (currentProjectId) loadProjectDetail(currentProjectId);
};

window.updateTicketPriority = async function(ticketId, priority) {
  await sb.from('tickets').update({ priority }).eq('id', ticketId);
  toast('Priority updated!', 'success');
};

window.saveAdminNotes = async function(ticketId) {
  const notes = document.getElementById('tk-admin-notes').value;
  await sb.from('tickets').update({ admin_notes: notes }).eq('id', ticketId);
  toast('Notes saved!', 'success');
};

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
async function loadNotifCount() {
  if (!currentUser) return;
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id).eq('is_read', false);
  const badge = document.getElementById('notif-count');
  if (count > 0) { badge.textContent = count > 9 ? '9+' : count; badge.style.display = 'flex'; }
  else badge.style.display = 'none';
}

function subscribeNotifications() {
  if (!currentUser) return;

  // Clean up any existing subscription first
  if (notifSubscription) { sb.removeChannel(notifSubscription); notifSubscription = null; }

  try {
    const channel = sb.channel(`notifs-${currentUser.id}`, {
      config: { broadcast: { self: false } }
    });

    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentUser.id}` },
      () => { loadNotifCount(); }
    );

    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        notifSubscription = channel;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || err) {
        // Realtime not available (table not in publication or Realtime disabled)
        // Fall back to polling every 30 seconds
        console.warn('Realtime unavailable, falling back to polling for notifications.');
        if (notifSubscription) { sb.removeChannel(notifSubscription); notifSubscription = null; }
        startNotifPolling();
      }
    });

    notifSubscription = channel;
  } catch (e) {
    console.warn('Realtime setup failed, falling back to polling:', e);
    startNotifPolling();
  }
}

let notifPollInterval = null;
function startNotifPolling() {
  if (notifPollInterval) return; // already polling
  notifPollInterval = setInterval(() => {
    if (currentUser) loadNotifCount();
    else { clearInterval(notifPollInterval); notifPollInterval = null; }
  }, 30000);
}

document.getElementById('bell-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const dd = document.getElementById('notif-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  if (dd.style.display === 'block') await loadNotifDropdown();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.notif-bell')) {
    const dd = document.getElementById('notif-dropdown');
    if (dd) dd.style.display = 'none';
  }
});

async function loadNotifDropdown() {
  const list = document.getElementById('notif-list');
  const { data } = await sb.from('notifications').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(20);
  if (!data?.length) { list.innerHTML = '<div class="notif-empty">No notifications</div>'; return; }
  list.innerHTML = data.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="markNotifRead('${n.id}')">
      <div class="notif-item-title">${escHtml(n.title)}</div>
      <div class="notif-item-msg">${escHtml(n.message)}</div>
      <div class="notif-item-time">${formatDate(n.created_at)}</div>
    </div>`).join('');
}

window.markNotifRead = async function(id) {
  await sb.from('notifications').update({ is_read: true }).eq('id', id);
  loadNotifCount();
  loadNotifDropdown();
};

document.getElementById('mark-all-read').addEventListener('click', async () => {
  await sb.from('notifications').update({ is_read: true }).eq('user_id', currentUser.id);
  loadNotifCount();
  loadNotifDropdown();
});

/* ============================================================
   ADMIN PANEL
   ============================================================ */
async function loadAdmin() {
  if (!isAdmin) { navigate('home'); return; }
  await loadAdminOverview();
}

// Tab switching
document.querySelectorAll('.admin-nav-item').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.admin-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.getAttribute('data-tab');
    document.getElementById(`tab-${tab}`).classList.add('active');
    const loaders = {
      overview: loadAdminOverview,
      requests: loadAdminRequests,
      projects: loadAdminProjects,
      meetings: loadAdminMeetings,
      users: loadAdminUsers,
      portfolio: loadAdminPortfolio,
      accounting: loadAdminAccounting,
      logs: loadAdminLogs,
      content: loadAdminContent,
      'contact-settings': loadAdminContactSettings,
    };
    if (loaders[tab]) await loaders[tab]();
  });
});

async function loadAdminOverview() {
  const [{ count: users }, { count: pending }, { count: active }, { data: payments }] = await Promise.all([
    sb.from('users').select('id', { count: 'exact', head: true }),
    sb.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    sb.from('projects').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    sb.from('payments').select('amount').eq('status', 'completed'),
  ]);
  document.getElementById('adm-total-users').textContent = users || 0;
  document.getElementById('adm-pending-req').textContent = pending || 0;
  document.getElementById('adm-active-projects').textContent = active || 0;
  const revenue = payments?.reduce((sum, p) => sum + Number(p.amount), 0) || 0;
  document.getElementById('adm-total-revenue').textContent = `EGP ${revenue.toFixed(2)}`;

  const { data: reqs } = await sb.from('requests').select('*, users(full_name)').order('created_at', { ascending: false }).limit(5);
  const el = document.getElementById('adm-recent-requests');
  if (!reqs?.length) { el.innerHTML = '<div class="empty-state">No requests yet.</div>'; return; }
  el.innerHTML = reqs.map(r => `
    <div class="request-card">
      <div class="request-card-header">
        <h3>${escHtml(r.title)} <span style="color:var(--text3);font-weight:400;font-size:0.85rem">by ${escHtml(r.users?.full_name||'Unknown')}</span></h3>
        ${badge(r.status)}
      </div>
      <p>${escHtml(r.description.substring(0,100))}…</p>
    </div>`).join('');
}

async function loadAdminRequests(filter = 'pending') {
  let q = sb.from('requests').select('*, users(full_name, email)').order('created_at', { ascending: false });
  if (filter !== 'all') q = q.eq('status', filter);
  const { data } = await q;
  const el = document.getElementById('admin-requests-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>No requests found.</p></div>'; return; }
  el.innerHTML = data.map(r => `
    <div class="request-card">
      <div class="request-card-header">
        <h3>${escHtml(r.title)}</h3>
        ${badge(r.status)}
      </div>
      <p style="margin-bottom:0.5rem"><strong style="color:var(--text2)">Client:</strong> ${escHtml(r.users?.full_name||'')} (${escHtml(r.users?.email||'')})</p>
      <p>${escHtml(r.description.substring(0,200))}${r.description.length>200?'…':''}</p>
      <div class="request-card-actions">
        ${r.status === 'pending' ? `
          <button class="btn-primary btn-sm" onclick="approveRequest('${r.id}')">Approve</button>
          <button class="btn-danger btn-sm" onclick="rejectRequest('${r.id}')">Reject</button>
          <input class="price-input" id="price-${r.id}" type="number" placeholder="Price EGP" value="${r.final_price||r.suggested_price||''}" />
          <span style="font-size:0.8rem;color:var(--text3)">Suggested: EGP ${r.suggested_price||0}</span>
        ` : r.status === 'approved' ? `
          <span style="color:var(--green);font-size:0.85rem">✓ Approved</span>
          ${r.final_price ? `<span style="color:var(--accent);font-family:var(--font-mono)">EGP ${r.final_price}</span>` : ''}
        ` : `<span style="color:var(--red);font-size:0.85rem">✕ Rejected</span>`}
      </div>
    </div>`).join('');

  // Filter buttons — only bind once
  if (!document.querySelector('.filter-btn').__filterBound) {
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.__filterBound = true;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadAdminRequests(btn.getAttribute('data-filter'));
      });
    });
  }
}

window.approveRequest = async function(reqId) {
  const priceEl = document.getElementById(`price-${reqId}`);
  const price = priceEl ? parseFloat(priceEl.value) || null : null;
  await sb.from('requests').update({ status: 'approved', final_price: price }).eq('id', reqId);
  const { data: req } = await sb.from('requests').select('*, users(full_name)').eq('id', reqId).single();
  // Create project
  if (req) {
    const { data: proj } = await sb.from('projects').insert({
      request_id: reqId, user_id: req.user_id,
      title: req.title, description: req.description,
      deadline: req.deadline, price: price, status: 'active'
    }).select().single();
    await sendNotification(req.user_id, 'Request Approved', `Your request "${req.title}" was approved!${price ? ` Price: EGP ${price}` : ''}`, 'success', 'project', proj?.id);
    await logActivity('request_approved', 'request', reqId, `Request approved: ${req.title}`);
  }
  toast('Request approved and project created!', 'success');
  loadAdminRequests(document.querySelector('.filter-btn.active')?.getAttribute('data-filter') || 'pending');
};

window.rejectRequest = async function(reqId) {
  await sb.from('requests').update({ status: 'rejected' }).eq('id', reqId);
  const { data: req } = await sb.from('requests').select('user_id, title').eq('id', reqId).single();
  if (req) {
    await sendNotification(req.user_id, 'Request Rejected', `Your request "${req.title}" was not approved at this time.`, 'warning', 'request', reqId);
    await logActivity('request_rejected', 'request', reqId, `Request rejected: ${req.title}`);
  }
  toast('Request rejected.', 'info');
  loadAdminRequests(document.querySelector('.filter-btn.active')?.getAttribute('data-filter') || 'pending');
};

async function loadAdminProjects() {
  const { data } = await sb.from('projects').select('*, users(full_name)').order('created_at', { ascending: false });
  const el = document.getElementById('admin-projects-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No projects yet.</div>'; return; }
  el.innerHTML = wrapTable(`<table class="data-table">
    <thead><tr><th>Title</th><th>Client</th><th>Status</th><th>Price</th><th>Paid</th><th>Deadline</th><th>Actions</th></tr></thead>
    <tbody>${data.map(p => `<tr>
      <td><strong>${escHtml(p.title)}</strong></td>
      <td style="color:var(--text2)">${escHtml(p.users?.full_name||'—')}</td>
      <td>${badge(p.status)}</td>
      <td style="font-family:var(--font-mono)">${p.price ? formatCurrency(p.price) : '—'}</td>
      <td>${p.is_paid ? '<span style="color:var(--green)">✓ Paid</span>' : `<button class="btn-ghost btn-sm" onclick="markProjectPaid('${p.id}')">Mark Paid</button>`}</td>
      <td>${formatDate(p.deadline)} ${countdown(p.deadline)}</td>
      <td>
        <div class="table-actions">
          <select class="price-input" style="width:110px" onchange="changeProjectStatus('${p.id}',this.value)">
            <option value="active" ${p.status==='active'?'selected':''}>Active</option>
            <option value="paused" ${p.status==='paused'?'selected':''}>Paused</option>
            <option value="completed" ${p.status==='completed'?'selected':''}>Completed</option>
            <option value="cancelled" ${p.status==='cancelled'?'selected':''}>Cancelled</option>
          </select>
          <button class="btn-ghost btn-sm" onclick="editProjectLimits('${p.id}',${p.max_tickets||10},${p.max_meetings||5})">Edit Limits</button>
          <button class="btn-ghost btn-sm" onclick="openProjectMeetings('${p.id}','${escHtml(p.title)}')">Meetings</button>
          <button class="btn-ghost btn-sm" onclick="loadProjectDetail('${p.id}')">View</button>
        </div>
      </td>
    </tr>`).join('')}</tbody>
  </table>`);
}

window.markProjectPaid = async function(projId) {
  await sb.from('projects').update({ is_paid: true }).eq('id', projId);
  const { data: proj } = await sb.from('projects').select('user_id, title, price').eq('id', projId).single();
  if (proj) {
    await sendNotification(proj.user_id, 'Payment Confirmed', `Payment of EGP ${proj.price} confirmed for "${proj.title}".`, 'success', 'project', projId);
    await logActivity('payment_recorded', 'project', projId, `Project marked as paid: ${proj.title}`);
  }
  toast('Project marked as paid!', 'success');
  loadAdminProjects();
};

window.changeProjectStatus = async function(projId, status) {
  await sb.from('projects').update({ status }).eq('id', projId);
  await logActivity('project_status_changed', 'project', projId, `Project status changed to ${status}`);
  toast('Status updated!', 'success');
};

window.openProjectMeetings = async function(projId, projTitle) {
  const { data: meetings } = await sb.from('meetings').select('*').eq('project_id', projId).order('scheduled_at');
  const meetingsHtml = meetings?.length ? meetings.map(m => `
    <div class="meeting-item">
      <span>${escHtml(m.title)} ${m.scheduled_at ? `<span style="color:var(--text3);font-size:0.75rem">${formatDate(m.scheduled_at)}</span>` : ''}</span>
      <div style="display:flex;gap:0.5rem;align-items:center">
        ${m.is_completed ? '<span style="color:var(--green);font-size:0.8rem">✓ Done</span>' : `<button class="btn-ghost btn-sm" onclick="completeMeeting('${m.id}','${projId}','${escHtml(projTitle)}')">Complete</button>`}
      </div>
    </div>`).join('') : '<p style="color:var(--text3);font-size:0.85rem">No meetings added yet.</p>';

  showModal(`
    <h2>Meetings — ${escHtml(projTitle)}</h2>
    <div id="meetings-list">${meetingsHtml}</div>
    <div style="border-top:1px solid var(--border);margin-top:1.25rem;padding-top:1.25rem">
      <h3 style="font-family:var(--font-display);font-size:1rem;margin-bottom:1rem">Add Meeting</h3>
      <div class="form-group"><label>Title</label><input type="text" id="mtg-title" placeholder="e.g. Kickoff Call" /></div>
      <div class="form-group"><label>Scheduled Date</label><input type="datetime-local" id="mtg-date" /></div>
      <button class="btn-primary btn-sm" onclick="addMeeting('${projId}','${escHtml(projTitle)}')">Add Meeting</button>
    </div>
  `);
};

window.addMeeting = async function(projId, projTitle) {
  const title = document.getElementById('mtg-title').value.trim();
  const date = document.getElementById('mtg-date').value;
  if (!title) { toast('Please enter a meeting title.', 'error'); return; }
  await sb.from('meetings').insert({ project_id: projId, title, scheduled_at: date || null });
  toast('Meeting added!', 'success');
  openProjectMeetings(projId, projTitle);
};

window.completeMeeting = async function(meetingId, projId, projTitle) {
  await sb.from('meetings').update({ is_completed: true }).eq('id', meetingId);
  toast('Meeting marked complete!', 'success');
  openProjectMeetings(projId, projTitle);
};

async function loadAdminUsers() {
  const { data } = await sb.from('users').select('*, roles(name)').order('created_at', { ascending: false });
  const el = document.getElementById('admin-users-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No users yet.</div>'; return; }
  el.innerHTML = wrapTable(`<table class="data-table">
    <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Joined</th><th>Actions</th></tr></thead>
    <tbody>${data.map(u => `<tr>
      <td><strong>${escHtml(u.full_name)}</strong></td>
      <td style="font-family:var(--font-mono);font-size:0.8rem">${escHtml(u.email)}</td>
      <td style="color:var(--text2)">${escHtml(u.phone||'—')}</td>
      <td><span class="badge ${u.roles?.name==='admin'?'badge-approved':'badge-pending'}">${escHtml(u.roles?.name||'user')}</span></td>
      <td style="color:var(--text2)">${formatDate(u.created_at)}</td>
      <td>
        ${u.roles?.name !== 'admin' ? `<button class="btn-ghost btn-sm" onclick="makeAdmin('${u.id}')">Make Admin</button>` : `<span style="color:var(--text3);font-size:0.8rem">Admin</span>`}
      </td>
    </tr>`).join('')}</tbody>
  </table>`);
}

window.makeAdmin = async function(userId) {
  const { data: adminRole } = await sb.from('roles').select('id').eq('name','admin').single();
  await sb.from('users').update({ role_id: adminRole.id }).eq('id', userId);
  toast('User promoted to admin!', 'success');
  loadAdminUsers();
};

async function loadAdminPortfolio() {
  const { data } = await sb.from('portfolio').select('*').order('display_order');
  const el = document.getElementById('admin-portfolio-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No portfolio items yet.</div>'; return; }
  el.innerHTML = data.map(p => `
    <div class="request-card" style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <strong>${escHtml(p.title)}</strong>
        <p style="color:var(--text2);font-size:0.8rem;margin-top:0.25rem">${escHtml((p.description||'').substring(0,80))}…</p>
      </div>
      <div style="display:flex;gap:0.5rem">
        <button class="btn-ghost btn-sm" onclick="togglePortfolioVisibility('${p.id}',${p.is_visible})">${p.is_visible ? 'Hide' : 'Show'}</button>
        <button class="btn-danger btn-sm" onclick="deletePortfolio('${p.id}')">Delete</button>
      </div>
    </div>`).join('');
}

let editingPortfolioId = null;
document.getElementById('add-portfolio-btn').addEventListener('click', () => {
  editingPortfolioId = null;
  document.getElementById('pf-title').value = '';
  document.getElementById('pf-desc').value = '';
  document.getElementById('pf-image').value = '';
  document.getElementById('pf-link').value = '';
  document.getElementById('pf-tags').value = '';
  document.getElementById('portfolio-form').style.display = 'block';
});
document.getElementById('cancel-portfolio-btn').addEventListener('click', () => { document.getElementById('portfolio-form').style.display = 'none'; });
document.getElementById('save-portfolio-btn').addEventListener('click', async () => {
  const title = document.getElementById('pf-title').value.trim();
  if (!title) { toast('Title is required.', 'error'); return; }
  const tags = document.getElementById('pf-tags').value.split(',').map(t=>t.trim()).filter(Boolean);
  const payload = {
    title, description: document.getElementById('pf-desc').value,
    image_url: document.getElementById('pf-image').value || null,
    external_link: document.getElementById('pf-link').value || null,
    tags, is_visible: true
  };
  const saveBtn = document.getElementById('save-portfolio-btn');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  try {
    let result;
    if (editingPortfolioId) {
      result = await sb.from('portfolio').update(payload).eq('id', editingPortfolioId);
    } else {
      result = await sb.from('portfolio').insert(payload);
    }
    if (result.error) { toast('Error: ' + result.error.message, 'error'); return; }
    toast('Portfolio saved!', 'success');
    document.getElementById('portfolio-form').style.display = 'none';
    editingPortfolioId = null;
    loadAdminPortfolio();
  } catch(e) {
    toast('Unexpected error saving portfolio.', 'error');
  } finally {
    saveBtn.disabled = false; saveBtn.textContent = 'Save';
  }
});

window.togglePortfolioVisibility = async function(id, current) {
  await sb.from('portfolio').update({ is_visible: !current }).eq('id', id);
  loadAdminPortfolio();
};
window.deletePortfolio = async function(id) {
  await sb.from('portfolio').delete().eq('id', id);
  toast('Deleted.', 'info');
  loadAdminPortfolio();
};

async function loadAdminAccounting() {
  const { data: payments } = await sb.from('payments').select('*, projects(title), users(full_name)').eq('status', 'completed').order('paid_at', { ascending: false });
  const total = payments?.reduce((sum, p) => sum + Number(p.amount), 0) || 0;
  const now = new Date();
  const monthPayments = payments?.filter(p => p.paid_at && new Date(p.paid_at).getMonth() === now.getMonth()) || [];
  const monthTotal = monthPayments.reduce((sum, p) => sum + Number(p.amount), 0);
  document.getElementById('acc-total').textContent = `EGP ${total.toFixed(2)}`;
  document.getElementById('acc-month').textContent = `EGP ${monthTotal.toFixed(2)}`;
  document.getElementById('acc-count').textContent = payments?.length || 0;
  const el = document.getElementById('payments-list');
  if (!payments?.length) { el.innerHTML = '<div class="empty-state">No payments yet.</div>'; return; }
  el.innerHTML = wrapTable(`<table class="data-table">
    <thead><tr><th>Project</th><th>Client</th><th>Amount</th><th>Date</th></tr></thead>
    <tbody>${payments.map(p => `<tr>
      <td>${escHtml(p.projects?.title||'—')}</td>
      <td style="color:var(--text2)">${escHtml(p.users?.full_name||'—')}</td>
      <td style="color:var(--accent);font-family:var(--font-mono)">EGP ${Number(p.amount).toFixed(2)}</td>
      <td style="color:var(--text2)">${formatDate(p.paid_at)}</td>
    </tr>`).join('')}</tbody>
  </table>`);
}

async function loadAdminLogs() {
  const { data } = await sb.from('activity_logs').select('*, users(full_name)').order('created_at', { ascending: false }).limit(50);
  const el = document.getElementById('activity-logs-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No activity yet.</div>'; return; }
  const icons = { request_created: '📝', request_approved: '✅', request_rejected: '❌', ticket_created: '🎫', ticket_status_changed: '🔄', payment_recorded: '💰', project_status_changed: '📊' };
  el.innerHTML = data.map(l => `
    <div class="log-row">
      <div class="log-icon">${icons[l.action_type]||'📌'}</div>
      <div class="log-info">
        <div class="log-action">${escHtml(l.description || l.action_type)}</div>
        <div class="log-time">${escHtml(l.users?.full_name||'System')} · ${formatDate(l.created_at)}</div>
      </div>
    </div>`).join('');
}

async function loadAdminContent() {
  const { data } = await sb.from('site_content').select('*').order('key');
  const el = document.getElementById('content-editor-list');
  if (!data?.length) { el.innerHTML = '<div class="empty-state">No content items found.</div>'; return; }
  el.innerHTML = data.map(c => `
    <div class="content-editor-row">
      <label>${escHtml(c.key)}</label>
      <textarea id="content-${c.id}" rows="${c.value?.length > 100 ? 4 : 2}">${escHtml(c.value||'')}</textarea>
      <button class="btn-primary btn-sm content-save-btn" onclick="saveContent('${c.id}','${c.key}')">Save</button>
    </div>`).join('');
}

window.saveContent = async function(id, key) {
  const value = document.getElementById(`content-${id}`).value;
  const btn = document.querySelector(`[onclick="saveContent('${id}','${key}')"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const { error } = await sb.from('site_content').update({ value, updated_by: currentUser.id }).eq('id', id);
    if (error) { toast('Error: ' + error.message, 'error'); return; }
    await logActivity('content_updated', 'site_content', id, `Content updated: ${key}`);
    toast('Content saved!', 'success');
    if (document.getElementById('page-home').classList.contains('active')) loadHome();
  } catch(e) {
    toast('Unexpected error saving content.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
};

/* ============================================================
   HAMBURGER MENU
   ============================================================ */
const hamburgerBtn = document.getElementById('hamburger-btn');
const mobileDrawer = document.getElementById('mobile-nav-drawer');

hamburgerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  hamburgerBtn.classList.toggle('open');
  mobileDrawer.classList.toggle('open');
});

// Close drawer when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#mobile-nav-drawer') && !e.target.closest('#hamburger-btn')) {
    hamburgerBtn.classList.remove('open');
    mobileDrawer.classList.remove('open');
  }
});

// Mobile nav links
document.querySelectorAll('[data-mobile-nav]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const page = el.getAttribute('data-page');
    if (!page) return;
    hamburgerBtn.classList.remove('open');
    mobileDrawer.classList.remove('open');
    const authPages = ['dashboard', 'projects', 'new-request', 'project-detail'];
    const adminPages = ['admin'];
    if (authPages.includes(page) && !currentUser) { navigate('login'); return; }
    if (adminPages.includes(page) && !isAdmin) { toast('Access denied.', 'error'); return; }
    navigate(page);
  });
});

// Mobile logout
document.getElementById('mobile-logout-btn').addEventListener('click', async () => {
  hamburgerBtn.classList.remove('open');
  mobileDrawer.classList.remove('open');
  await sb.auth.signOut();
  toast('Signed out.', 'info');
});

/* ============================================================
   UTILS — wrap tables for mobile scroll
   ============================================================ */
function wrapTable(html) {
  return `<div class="data-table-wrapper">${html}</div>`;
}


function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.getElementById('modal-content').innerHTML = '';
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

/* ============================================================
   CONTACT PAGE
   ============================================================ */
async function loadContact() {
  const { data: content } = await sb.from('site_content').select('key, value').in('key', ['contact_email','contact_phone','contact_location','contact_github','contact_linkedin','contact_twitter']);
  if (content) {
    const map = Object.fromEntries(content.map(c => [c.key, c.value]));
    if (map.contact_email) document.getElementById('contact-email-display').textContent = map.contact_email;
    if (map.contact_phone) document.getElementById('contact-phone-display').textContent = map.contact_phone;
    if (map.contact_location) document.getElementById('contact-location-display').textContent = map.contact_location;
    const gh = document.getElementById('contact-github-link');
    const li = document.getElementById('contact-linkedin-link');
    const tw = document.getElementById('contact-twitter-link');
    if (map.contact_github && map.contact_github.trim()) { gh.href = map.contact_github; gh.style.display = ''; } else { gh.style.display = 'none'; }
    if (map.contact_linkedin && map.contact_linkedin.trim()) { li.href = map.contact_linkedin; li.style.display = ''; } else { li.style.display = 'none'; }
    if (map.contact_twitter && map.contact_twitter.trim()) { tw.href = map.contact_twitter; tw.style.display = ''; } else { tw.style.display = 'none'; }
  }
  // Pre-fill name/email if logged in
  if (currentUserProfile) {
    document.getElementById('contact-name').value = currentUserProfile.full_name || '';
    document.getElementById('contact-email').value = currentUserProfile.email || '';
  }
}

document.getElementById('send-contact-btn').addEventListener('click', async () => {
  const name = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const subject = document.getElementById('contact-subject').value.trim();
  const message = document.getElementById('contact-message').value.trim();
  const err = document.getElementById('contact-error');
  const succ = document.getElementById('contact-success');
  const btn = document.getElementById('send-contact-btn');
  err.style.display = 'none'; succ.style.display = 'none';
  if (!name || !email || !message) { err.textContent = 'Name, email, and message are required.'; err.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const { error } = await sb.from('contact_messages').insert({ name, email, subject: subject || null, message });
    if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
    succ.style.display = 'block';
    document.getElementById('contact-subject').value = '';
    document.getElementById('contact-message').value = '';
    toast('Message sent! We\'ll be in touch.', 'success');
  } catch(e) {
    err.textContent = 'Unexpected error. Please try again.'; err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Send Message →';
  }
});

/* ============================================================
   MEETING REQUESTS (User side)
   ============================================================ */
window.openMeetingRequestModal = function(projectId) {
  showModal(`
    <h2>Request a Meeting</h2>
    <p style="color:var(--text2);font-size:0.875rem;margin-bottom:1.5rem">Request a meeting with your project manager. They'll confirm the time.</p>
    <div id="mtgreq-err" class="form-error" style="display:none"></div>
    <div class="form-group">
      <label>Topic / Agenda</label>
      <textarea id="mtgreq-topic" rows="3" placeholder="What would you like to discuss?"></textarea>
    </div>
    <div class="form-group">
      <label>Preferred Date & Time (optional)</label>
      <input type="datetime-local" id="mtgreq-date" />
    </div>
    <button class="btn-primary full" onclick="submitMeetingRequest('${projectId}')">Send Request →</button>
  `);
};

window.submitMeetingRequest = async function(projectId) {
  const topic = document.getElementById('mtgreq-topic').value.trim();
  const date = document.getElementById('mtgreq-date').value;
  const err = document.getElementById('mtgreq-err');
  const btn = document.querySelector('#modal-content .btn-primary.full');
  err.style.display = 'none';
  if (!topic) { err.textContent = 'Please enter a topic.'; err.style.display = 'block'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const { error } = await sb.from('meeting_requests').insert({
      project_id: projectId, user_id: currentUser.id,
      topic, requested_date: date || null, status: 'pending'
    });
    if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
    // Notify admins
    const { data: adminRole } = await sb.from('roles').select('id').eq('name', 'admin').single();
    const { data: admins } = adminRole ? await sb.from('users').select('id').eq('role_id', adminRole.id) : { data: [] };
    if (admins) {
      for (const admin of admins) {
        await sendNotification(admin.id, 'Meeting Request', `${currentUserProfile?.full_name || 'A user'} requested a meeting: "${topic}"`, 'info', 'meeting_request', null);
      }
    }
    closeModal();
    toast('Meeting request sent!', 'success');
  } catch(e) {
    err.textContent = 'Unexpected error.'; err.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send Request →'; }
  }
};

/* ============================================================
   ADMIN – MEETINGS TAB (global view + edit)
   ============================================================ */
async function loadAdminMeetings(filter = 'all') {
  const el = document.getElementById('admin-meetings-list');
  el.innerHTML = '<div style="padding:2rem;color:var(--text3);text-align:center">Loading…</div>';

  // Load meeting_requests
  let reqQuery = sb.from('meeting_requests').select('*, projects(title), users(full_name)').order('created_at', { ascending: false });
  const { data: requests } = await reqQuery;

  // Load admin-created meetings
  let mtgQuery = sb.from('meetings').select('*, projects(title, user_id, users(full_name))').order('scheduled_at', { ascending: true });
  if (filter === 'upcoming') mtgQuery = mtgQuery.eq('is_completed', false);
  if (filter === 'completed') mtgQuery = mtgQuery.eq('is_completed', true);
  const { data: meetings } = await mtgQuery;

  let html = '';

  // Meeting Requests section
  const pendingReqs = requests?.filter(r => r.status === 'pending') || [];
  if (pendingReqs.length > 0) {
    html += `<div style="margin-bottom:2rem">
      <h3 style="font-family:var(--font-display);font-size:1rem;margin-bottom:1rem;color:var(--accent)">⏳ Pending Meeting Requests (${pendingReqs.length})</h3>
      ${pendingReqs.map(r => `
        <div class="request-card" style="margin-bottom:0.75rem">
          <div class="request-card-header">
            <h3>${escHtml(r.projects?.title || '—')}</h3>
            <span class="badge badge-pending">Pending</span>
          </div>
          <p><strong>${escHtml(r.users?.full_name || '—')}</strong>: ${escHtml(r.topic)}</p>
          ${r.requested_date ? `<p style="font-size:0.8rem;color:var(--text3)">Preferred: ${formatDate(r.requested_date)}</p>` : ''}
          <div class="request-card-actions" style="margin-top:0.75rem">
            <button class="btn-primary btn-sm" onclick="approveMeetingRequest('${r.id}','${r.project_id}','${escHtml(r.topic)}')">Approve & Schedule</button>
            <button class="btn-danger btn-sm" onclick="rejectMeetingRequest('${r.id}')">Decline</button>
          </div>
        </div>`).join('')}
    </div>`;
  }

  if (!meetings?.length) {
    html += '<div class="empty-state"><div class="empty-state-icon">📅</div><p>No meetings found.</p></div>';
  } else {
    html += `<h3 style="font-family:var(--font-display);font-size:1rem;margin-bottom:1rem">All Scheduled Meetings</h3>
    <table class="data-table">
      <thead><tr><th>Meeting</th><th>Project</th><th>Client</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${meetings.map(m => `<tr>
        <td><strong>${escHtml(m.title)}</strong></td>
        <td style="color:var(--text2)">${escHtml(m.projects?.title || '—')}</td>
        <td style="color:var(--text2)">${escHtml(m.projects?.users?.full_name || '—')}</td>
        <td style="font-family:var(--font-mono);font-size:0.8rem">${m.scheduled_at ? formatDate(m.scheduled_at) : '—'}</td>
        <td>${m.is_completed ? '<span style="color:var(--green)">✓ Done</span>' : '<span style="color:var(--yellow)">Upcoming</span>'}</td>
        <td>
          <div style="display:flex;gap:0.5rem">
            <button class="btn-ghost btn-sm" onclick="editMeetingModal('${m.id}','${escHtml(m.title)}','${m.scheduled_at||''}','${escHtml(m.notes||'')}')">Edit</button>
            ${!m.is_completed ? `<button class="btn-ghost btn-sm" onclick="adminCompleteMeeting('${m.id}')">Complete</button>` : ''}
            <button class="btn-danger btn-sm" onclick="adminDeleteMeeting('${m.id}')">Delete</button>
          </div>
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  el.innerHTML = html;

  // Bind filter buttons
  document.querySelectorAll('#meetings-filter .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#meetings-filter .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadAdminMeetings(btn.getAttribute('data-mfilter'));
    });
  });
}

window.approveMeetingRequest = async function(reqId, projId, topic) {
  showModal(`
    <h2>Schedule Meeting</h2>
    <p style="color:var(--text2);font-size:0.875rem;margin-bottom:1.5rem">Topic: <strong>${escHtml(topic)}</strong></p>
    <div id="sched-err" class="form-error" style="display:none"></div>
    <div class="form-group"><label>Meeting Title</label><input type="text" id="sched-title" value="${escHtml(topic)}" /></div>
    <div class="form-group"><label>Date & Time</label><input type="datetime-local" id="sched-date" /></div>
    <button class="btn-primary full" onclick="confirmScheduleMeeting('${reqId}','${projId}')">Confirm & Schedule</button>
  `);
};

window.confirmScheduleMeeting = async function(reqId, projId) {
  const title = document.getElementById('sched-title').value.trim();
  const date = document.getElementById('sched-date').value;
  const err = document.getElementById('sched-err');
  const btn = document.querySelector('#modal-content .btn-primary.full');
  if (!title) { err.textContent = 'Please enter a title.'; err.style.display = 'block'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await sb.from('meetings').insert({ project_id: projId, title, scheduled_at: date || null });
    await sb.from('meeting_requests').update({ status: 'approved' }).eq('id', reqId);
    // Notify user
    const { data: req } = await sb.from('meeting_requests').select('user_id').eq('id', reqId).single();
    if (req) await sendNotification(req.user_id, 'Meeting Scheduled', `Your meeting request "${title}" has been approved and scheduled.`, 'success');
    closeModal();
    toast('Meeting scheduled!', 'success');
    loadAdminMeetings();
  } catch(e) {
    err.textContent = 'Error scheduling.'; err.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm & Schedule'; }
  }
};

window.rejectMeetingRequest = async function(reqId) {
  await sb.from('meeting_requests').update({ status: 'rejected' }).eq('id', reqId);
  const { data: req } = await sb.from('meeting_requests').select('user_id, topic').eq('id', reqId).single();
  if (req) await sendNotification(req.user_id, 'Meeting Request Declined', `Your meeting request "${req.topic}" was declined.`, 'warning');
  toast('Request declined.', 'info');
  loadAdminMeetings();
};

window.editMeetingModal = function(meetingId, title, scheduled_at, notes) {
  const dateVal = scheduled_at ? new Date(scheduled_at).toISOString().slice(0,16) : '';
  showModal(`
    <h2>Edit Meeting</h2>
    <div id="edit-mtg-err" class="form-error" style="display:none"></div>
    <div class="form-group"><label>Title</label><input type="text" id="edit-mtg-title" value="${escHtml(title)}" /></div>
    <div class="form-group"><label>Date & Time</label><input type="datetime-local" id="edit-mtg-date" value="${escHtml(dateVal)}" /></div>
    <div class="form-group"><label>Notes</label><textarea id="edit-mtg-notes" rows="3">${escHtml(notes)}</textarea></div>
    <div style="display:flex;gap:0.75rem">
      <button class="btn-primary" onclick="saveEditedMeeting('${meetingId}')">Save Changes</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
};

window.saveEditedMeeting = async function(meetingId) {
  const title = document.getElementById('edit-mtg-title').value.trim();
  const date = document.getElementById('edit-mtg-date').value;
  const notes = document.getElementById('edit-mtg-notes').value;
  const err = document.getElementById('edit-mtg-err');
  if (!title) { err.textContent = 'Title required.'; err.style.display = 'block'; return; }
  const { error } = await sb.from('meetings').update({ title, scheduled_at: date || null, notes }).eq('id', meetingId);
  if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
  closeModal();
  toast('Meeting updated!', 'success');
  loadAdminMeetings();
};

window.adminCompleteMeeting = async function(meetingId) {
  await sb.from('meetings').update({ is_completed: true }).eq('id', meetingId);
  toast('Marked complete!', 'success');
  loadAdminMeetings();
};

window.adminDeleteMeeting = async function(meetingId) {
  if (!confirm('Delete this meeting?')) return;
  await sb.from('meetings').delete().eq('id', meetingId);
  toast('Meeting deleted.', 'info');
  loadAdminMeetings();
};

/* ============================================================
   ADMIN – CONTACT SETTINGS
   ============================================================ */
async function loadAdminContactSettings() {
  const keys = ['contact_email','contact_phone','contact_location','contact_github','contact_linkedin','contact_twitter'];
  const { data } = await sb.from('site_content').select('key, value').in('key', keys);
  if (data) {
    const map = Object.fromEntries(data.map(c => [c.key, c.value]));
    document.getElementById('cs-email').value = map.contact_email || '';
    document.getElementById('cs-phone').value = map.contact_phone || '';
    document.getElementById('cs-location').value = map.contact_location || '';
    document.getElementById('cs-github').value = map.contact_github || '';
    document.getElementById('cs-linkedin').value = map.contact_linkedin || '';
    document.getElementById('cs-twitter').value = map.contact_twitter || '';
  }
}

document.getElementById('save-contact-settings-btn').addEventListener('click', async () => {
  const fields = {
    contact_email: document.getElementById('cs-email').value.trim(),
    contact_phone: document.getElementById('cs-phone').value.trim(),
    contact_location: document.getElementById('cs-location').value.trim(),
    contact_github: document.getElementById('cs-github').value.trim(),
    contact_linkedin: document.getElementById('cs-linkedin').value.trim(),
    contact_twitter: document.getElementById('cs-twitter').value.trim(),
  };
  const btn = document.getElementById('save-contact-settings-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    for (const [key, value] of Object.entries(fields)) {
      await sb.from('site_content').upsert({ key, value, updated_by: currentUser.id }, { onConflict: 'key' });
    }
    toast('Contact info saved!', 'success');
  } catch(e) {
    toast('Error saving contact info.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Contact Info';
  }
});

/* ============================================================
   ADMIN – TICKET COUNT EDIT IN USERS TAB
   ============================================================ */
window.editProjectLimits = async function(projectId, currentMaxTickets, currentMaxMeetings) {
  showModal(`
    <h2>Edit Project Limits</h2>
    <div id="limits-err" class="form-error" style="display:none"></div>
    <div class="form-row">
      <div class="form-group">
        <label>Max Tickets</label>
        <input type="number" id="lim-tickets" value="${currentMaxTickets}" min="1" max="999" />
      </div>
      <div class="form-group">
        <label>Max Meetings</label>
        <input type="number" id="lim-meetings" value="${currentMaxMeetings}" min="1" max="999" />
      </div>
    </div>
    <div style="display:flex;gap:0.75rem">
      <button class="btn-primary" onclick="saveProjectLimits('${projectId}')">Save</button>
      <button class="btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
};

window.saveProjectLimits = async function(projectId) {
  const maxTickets = parseInt(document.getElementById('lim-tickets').value);
  const maxMeetings = parseInt(document.getElementById('lim-meetings').value);
  const err = document.getElementById('limits-err');
  if (!maxTickets || maxTickets < 1) { err.textContent = 'Invalid ticket count.'; err.style.display = 'block'; return; }
  if (!maxMeetings || maxMeetings < 1) { err.textContent = 'Invalid meeting count.'; err.style.display = 'block'; return; }
  const { error } = await sb.from('projects').update({ max_tickets: maxTickets, max_meetings: maxMeetings }).eq('id', projectId);
  if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
  closeModal();
  toast('Project limits updated!', 'success');
  loadAdminProjects();
};

/* ============================================================
   EXPOSE GLOBALS FOR INLINE ONCLICK
   ============================================================ */
window.loadProjectDetail = loadProjectDetail;
window.openTicketDetail = openTicketDetail;
window.openNewTicketModal = openNewTicketModal;
window.navigate = navigate;
window.openMeetingRequestModal = openMeetingRequestModal;
// submitNewTicket already on window

/* ============================================================
   BOOT
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  const ls = document.getElementById('loading-screen');

  function hideLoader() {
    if (ls) ls.classList.add('hidden');
  }

  // Always show app regardless of auth state
  document.getElementById('app').style.display = 'block';
  navigate('home');

  // HARD safety net — loader gone after 2s no matter what
  const safetyTimer = setTimeout(hideLoader, 2000);

  // If Supabase failed to load (e.g. offline / file:// blocked), bail out gracefully
  if (typeof supabase === 'undefined' || !window.supabase) {
    console.warn('Supabase not loaded — running in offline mode');
    clearTimeout(safetyTimer);
    hideLoader();
    return;
  }

  // Run auth in background; hide loader when done (or on error)
  initAuth().finally(() => {
    clearTimeout(safetyTimer);
    hideLoader();
  });
});