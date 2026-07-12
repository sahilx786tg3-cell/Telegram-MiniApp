// =====================================================
// CONFIG — SUPABASE CONNECTION (FROM YOUR INDEX)
// =====================================================
const SUPABASE_URL = 'https://qzgfmqvtbyxmwuzqflmn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XrIYLJmvjjMb6BkMNeCqnA_IIoDaTGY';
const BACKEND_URL = 'https://milkyrush-v2-production.up.railway.app'; // Railway bot backend - handles membership checks so the bot token never touches the client

// Matches the backend's todayStr() (UTC ISO date, e.g. "2026-07-11") exactly.
// Previously this compared using the device's LOCAL timezone (toDateString()),
// which disagreed with the server's UTC-based "already claimed today?" check -
// e.g. for an IST user (UTC+5:30), local midnight arrives 5.5 hours before UTC
// midnight, so the app could show the Claim button as active for a "new day"
// that the server still considered the same day as the last claim, making a
// legitimate-looking claim get rejected with "already claimed".
function utcDateStr(dateInput) {
  return new Date(dateInput).toISOString().slice(0, 10);
}
const BOT_USERNAME = 'MilkRushBot';
const CHANNEL = '@MilkRushOfficial';

// Calls one of our admin-protected backend endpoints, attaching Telegram's
// signed initData so the backend can verify the request really comes from
// the admin's Telegram account (see requireAdmin in index.js).
async function adminApi(path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': window.Telegram?.WebApp?.initData || '',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || 'request failed');
  return data;
}
const ADMIN_ID = 6520878121; // sirf ye Telegram ID admin panel dekh/khol sakti hai

// Calls a user-facing reward endpoint on the backend, attaching Telegram's
// signed initData so the server knows exactly which Telegram account is
// making the request. This REPLACES all direct anon-key writes to `users`
// for anything balance-related (tap, ads, daily, channel, withdrawal) - the
// backend recomputes/validates everything server-side before touching money.
async function apiUser(path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': window.Telegram?.WebApp?.initData || '',
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'request failed');
  return data;
}

// GRAM exchange config
const ADS_REQUIRED = 10; // lifetime ads milestone used for the one-time referral bonus payout
const WITHDRAWAL_DAILY_ADS_REQUIRED = 10; // fallback default; real value now comes from appSettings (admin-editable)
const WITHDRAWAL_REFERRALS_REQUIRED = 3; // fallback default; real value now comes from appSettings (admin-editable)

// If the admin disables a requirement, it's treated as "0 needed" (always satisfied).
// Escapes user-controlled text (e.g. Telegram first_name/username) before it's
// inserted into innerHTML, so a malicious display name can't inject a script
// that runs inside the admin's own privileged session.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function getAdsRequiredForWithdrawal() {
  if (appSettings.withdrawal_ads_enabled === false) return 0;
  return appSettings.withdrawal_ads_required ?? WITHDRAWAL_DAILY_ADS_REQUIRED;
}
function getReferralsRequiredForWithdrawal() {
  if (appSettings.withdrawal_referrals_enabled === false) return 0;
  return appSettings.withdrawal_referrals_required ?? WITHDRAWAL_REFERRALS_REQUIRED;
}
// GRAM has been removed - Milk now only converts to USDT
const MILK_PER_USDT = 100000; // 10,000 Milk = 0.1 USDT  ->  100,000 Milk = 1 USDT
const MIN_EXCHANGE_MILK = 10000;
const MIN_SWAP_MILK = 10;
// =====================================================

const API = (path) => `${SUPABASE_URL}/rest/v1/${path}`;
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Prefer': 'return=representation'
};

// Multi-device / multi-account lock has been removed on the frontend -
// no device ID or fingerprint is generated or sent anymore. NOTE: if the
// backend (index.js -> requireDeviceCheck) still rejects /api/user/sync
// based on device info, that server-side check needs to be removed too.

let currentUser = null;
let tgUser = null;
let channelJoined = false;
let allChannels = [];
let allWithdrawalsCache = [];
let logoClickCount = 0;
let exchangeAmount = MIN_EXCHANGE_MILK;
let appSettings = { id: 1, ad_reward: 50, ads_daily_limit: 10, referral_instant_reward: 50, referral_ads_reward: 100, min_withdrawal_usdt: 0.1, min_swap_usdt_milk: 10, daily_reward_base: 100, channel_reward: 1000, tap_energy_max: 100, tap_cooldown_minutes: 30, tap_daily_limit: 500, withdrawal_ads_required: 10, withdrawal_ads_enabled: true, withdrawal_referrals_required: 3, withdrawal_referrals_enabled: true, spin_ads_required: 5, spin_prizes: null };
let allUsersCache = [];
let adjustBalanceTargetId = null;

// DATABASE FUNCTIONS
async function dbGet(table, filter='') {
  try {
    const url = filter ? `${API(table)}?${filter}` : API(table);
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) {
      const body = await r.text().catch(()=> '');
      throw new Error(`DB Error: ${r.status} — ${body}`);
    }
    return await r.json();
  } catch(e) {
    console.error('dbGet error:', e);
    alert('DEBUG dbGet(' + table + ') FAILED:\n' + e.message); // TEMP DEBUG — remove after fixing
    return [];
  }
}

async function dbInsert(table, data) {
  const r = await fetch(API(table), { method:'POST', headers:HEADERS, body:JSON.stringify(data) });
  if (!r.ok) {
    const body = await r.text().catch(()=> '');
    console.error(`dbInsert(${table}) failed: ${r.status} — ${body}`);
    throw new Error(`Insert Error: ${r.status} — ${body}`);
  }
  return await r.json();
}

async function dbUpdate(table, filter, data) {
  const r = await fetch(`${API(table)}?${filter}`, { method:'PATCH', headers:HEADERS, body:JSON.stringify(data) });
  if (!r.ok) {
    const body = await r.text().catch(()=> '');
    console.error(`dbUpdate(${table}) failed: ${r.status} — ${body}`);
    throw new Error(`Update Error: ${r.status} — ${body}`);
  }
  return await r.json();
}

// Fetches ALL rows for a table by looping in pages, bypassing Supabase's server-side
// "max rows" cap (which otherwise silently truncates a plain dbGet() to e.g. 10/1000 rows).
async function dbGetAll(table, filter='') {
  let all = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const sep = filter ? filter + '&' : '';
    const batch = await dbGet(table, `${sep}limit=${pageSize}&offset=${offset}`);
    if (!batch || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < pageSize) break; // last page reached
    offset += batch.length;
  }
  return all;
}

async function fetchSettings() {
  try {
    const rows = await dbGet('settings', 'id=eq.1');
    if (rows.length > 0) {
      appSettings = {
        id: 1,
        ad_reward: rows[0].ad_reward ?? 50,
        ads_daily_limit: rows[0].ads_daily_limit ?? 10,
        referral_instant_reward: rows[0].referral_instant_reward ?? 50,
        referral_ads_reward: rows[0].referral_ads_reward ?? 100,
        min_withdrawal_usdt: rows[0].min_withdrawal_usdt ?? 0.1,
        min_swap_usdt_milk: rows[0].min_swap_usdt_milk ?? 10,
        daily_reward_base: rows[0].daily_reward_base ?? 100,
        channel_reward: rows[0].channel_reward ?? 1000,
        tap_energy_max: rows[0].tap_energy_max ?? 100,
        tap_cooldown_minutes: rows[0].tap_cooldown_minutes ?? 30,
        tap_daily_limit: rows[0].tap_daily_limit ?? 500,
        withdrawal_ads_required: rows[0].withdrawal_ads_required ?? 10,
        withdrawal_ads_enabled: rows[0].withdrawal_ads_enabled ?? true,
        withdrawal_referrals_required: rows[0].withdrawal_referrals_required ?? 3,
        withdrawal_referrals_enabled: rows[0].withdrawal_referrals_enabled ?? true,
        spin_ads_required: rows[0].spin_ads_required ?? 5,
        spin_prizes: rows[0].spin_prizes ?? null
      };
    } else {
      // Anon key is now read-only (RLS locked down) - it can no longer seed this
      // row directly. In the very unlikely case the settings row is missing,
      // fall back to the hardcoded defaults already set on appSettings above;
      // an admin should create/save the row once via the Admin Panel settings
      // form, which goes through the backend's service-role-backed endpoint.
      console.warn('Settings row missing - using built-in defaults until an admin saves settings once.');
    }
  } catch(e) {
    console.error('Settings fetch error:', e);
  }
}

async function saveSettings() {
  const adReward = parseInt(document.getElementById('settingAdReward').value) || 50;
  const adsDailyLimit = parseInt(document.getElementById('settingAdsDailyLimit').value) || 10;
  const referralInstant = parseInt(document.getElementById('settingReferralInstant').value) || 50;
  const referralAdsBonus = parseInt(document.getElementById('settingReferralAdsBonus').value) || 100;
  const minWithdrawalUsdt = parseFloat(document.getElementById('settingMinWithdrawalUsdt').value) || 0.1;
  const minSwapUsdt = parseInt(document.getElementById('settingMinSwapUsdt').value) || 10;
  const dailyRewardBase = parseInt(document.getElementById('settingDailyRewardBase').value) || 100;
  const channelReward = parseInt(document.getElementById('settingChannelReward').value) || 1000;
  const tapEnergyMax = parseInt(document.getElementById('settingTapEnergyMax').value) || 100;
  const tapCooldown = parseInt(document.getElementById('settingTapCooldown').value) || 30;
  const tapDailyLimit = parseInt(document.getElementById('settingTapDailyLimit').value) || 500;
  const withdrawAdsRequired = parseInt(document.getElementById('settingWithdrawAdsRequired').value) || 0;
  const withdrawAdsEnabled = document.getElementById('settingWithdrawAdsEnabled').checked;
  const withdrawReferralsRequired = parseInt(document.getElementById('settingWithdrawReferralsRequired').value) || 0;
  const withdrawReferralsEnabled = document.getElementById('settingWithdrawReferralsEnabled').checked;
  const spinAdsRequired = parseInt(document.getElementById('settingSpinAdsRequired').value) || 5;
  const spinPrizes = collectSpinPrizesFromForm();
  try {
    await adminApi('/api/admin/settings', {
      ad_reward: adReward,
      ads_daily_limit: adsDailyLimit,
      referral_instant_reward: referralInstant,
      referral_ads_reward: referralAdsBonus,
      min_withdrawal_usdt: minWithdrawalUsdt,
      min_swap_usdt_milk: minSwapUsdt,
      daily_reward_base: dailyRewardBase,
      channel_reward: channelReward,
      tap_energy_max: tapEnergyMax,
      tap_cooldown_minutes: tapCooldown,
      tap_daily_limit: tapDailyLimit,
      withdrawal_ads_required: withdrawAdsRequired,
      withdrawal_ads_enabled: withdrawAdsEnabled,
      withdrawal_referrals_required: withdrawReferralsRequired,
      withdrawal_referrals_enabled: withdrawReferralsEnabled,
      spin_ads_required: spinAdsRequired,
      spin_prizes: spinPrizes
    });
    appSettings = {
      id: 1,
      ad_reward: adReward,
      ads_daily_limit: adsDailyLimit,
      referral_instant_reward: referralInstant,
      referral_ads_reward: referralAdsBonus,
      min_withdrawal_usdt: minWithdrawalUsdt,
      min_swap_usdt_milk: minSwapUsdt,
      daily_reward_base: dailyRewardBase,
      channel_reward: channelReward,
      tap_energy_max: tapEnergyMax,
      tap_cooldown_minutes: tapCooldown,
      tap_daily_limit: tapDailyLimit,
      withdrawal_ads_required: withdrawAdsRequired,
      withdrawal_ads_enabled: withdrawAdsEnabled,
      withdrawal_referrals_required: withdrawReferralsRequired,
      withdrawal_referrals_enabled: withdrawReferralsEnabled,
      spin_ads_required: spinAdsRequired,
      spin_prizes: spinPrizes
    };
    showToast('✅ Settings saved!');
  } catch(e) {
    console.error('Save settings error:', e);
    showToast('❌ Save failed — check console (often a missing DB column)');
  }
}

function getDailyRewards() {
  const base = appSettings.daily_reward_base || 100;
  return [base, base * 1.5, base * 2, base * 2.5, base * 3, base * 4, base * 5].map(n => Math.round(n));
}

// ISO date-only (e.g. "2026-07-09") - must match the server's todayStr()
// format exactly, or these "already done today?" checks silently reset
// to 0 every time (this is what was breaking the daily tap/ad limits).
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getTodayAdsWatched(user) {
  const today = todayISO();
  return user.last_ad_date === today ? (user.ads_watched_today || 0) : 0;
}

function getTodayTapsCount(user) {
  const today = todayISO();
  return user.last_tap_date === today ? (user.taps_today || 0) : 0;
}

// INIT
window.addEventListener('load', async () => {
  if (window.Telegram?.WebApp) {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();
    tgUser = Telegram.WebApp.initDataUnsafe?.user;
  }
  if (!tgUser) tgUser = { id: 123456789, first_name: 'Demo', username: 'demouser' };
  
  document.getElementById('logoClick').addEventListener('click', logoTripleClick);
  
  await fetchSettings();
  await loadOrCreateUser();
  await loadChannels();
  setTimeout(() => { document.getElementById('loadingScreen').style.display='none'; }, 2000);

  // AUTOMATIC ADS: shows up to 2 interstitials within a 6-min window after opening,
  // 30s apart, first one after a 5s delay. Session persists across page navigation.
  // Skipped for the admin so opening the Mini App straight into the Admin Panel is ad-free.
  if (typeof show_11250385 === 'function' && (!tgUser || tgUser.id !== ADMIN_ID)) {
    show_11250385({
      type: 'inApp',
      inAppSettings: { frequency: 2, capping: 0.1, interval: 30, timeout: 5, everyPage: false }
    });
  }

  // ADMIN AUTO-OPEN: sirf ADMIN_ID wale user ko Mini App open hote hee Admin Panel dikhega
  if (tgUser && tgUser.id === ADMIN_ID) {
    openAdminPanel();
  } else if (currentUser && currentUser.banned) {
    document.getElementById('userApp').style.display = 'none';
    document.getElementById('bannedScreen').classList.add('active');
  }
});

// LOGO TRIPLE CLICK (sirf admin ke liye manual re-open, koi password nahi — ID hee check hoti hai)
function logoTripleClick() {
  logoClickCount++;
  if (logoClickCount === 3) {
    logoClickCount = 0;
    if (tgUser && tgUser.id === ADMIN_ID) {
      openAdminPanel();
    } else {
      showToast('❌ Access denied!');
    }
  }
  setTimeout(() => { logoClickCount = 0; }, 500);
}

// USER FUNCTIONS
async function loadOrCreateUser() {
  try {
    // Get-or-create now happens server-side (see /api/user/sync in index.js):
    // the backend verifies Telegram's signed initData, so a fresh user row
    // and the one-time referral instant-bonus can only be created for the
    // Telegram account that's actually opening the app - not spoofed by a
    // client editing its own request.
    const tgStartParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
    const refCode = tgStartParam || new URLSearchParams(window.location.search).get('ref');
    const { user, created } = await apiUser('/api/user/sync', { ref: refCode || null });
    currentUser = user;
    if (created) showToast('🥛 Welcome to Milky Rush!');

    if (currentUser.channel_joined) { channelJoined = true; }
    if (currentUser.ads_watched == null) currentUser.ads_watched = 0;
    if (currentUser.completed_channels == null) currentUser.completed_channels = [];
    renderUI();
    updateTapEnergyDisplay();
  } catch(e) {
    console.error('Load user error:', e);
    showToast('⚠️ Connection error!');
  }
}

async function loadChannels() {
  try {
    allChannels = await dbGet('channels');
    renderDynamicTasks();
  } catch(e) {
    console.error('Load channels error:', e);
  }
}

function renderDynamicTasks() {
  const container = document.getElementById('dynamicChannelTasks');
  if (!container) return;
  if (!allChannels || allChannels.length === 0) { container.innerHTML = ''; return; }

  const completed = currentUser?.completed_channels || [];
  container.innerHTML = allChannels.map(c => {
    const done = completed.includes(c.id);
    const verifying = pendingVerify.has(c.id);
    const claiming = taskClaimsInFlight.has(c.id);
    const label = done ? '✅ Done' : (claiming ? 'Checking...' : (verifying ? 'Verify' : 'Join'));
    return `
      <div class="task-card">
        <div class="task-left">
          <div class="task-icon">${c.icon || '📢'}</div>
          <div>
            <div class="task-name">Join ${c.name}</div>
            <div class="task-desc">${c.description || 'Join our Telegram channel'}</div>
          </div>
        </div>
        <div class="task-right">
          <div class="task-reward">+${(c.reward || 0).toLocaleString()} 🥛</div>
          <button class="task-btn ${done ? 'done' : ''}" ${(done || claiming) ? 'disabled' : ''} onclick="handleDynamicTask(${c.id})">${label}</button>
        </div>
      </div>`;
  }).join('');
}

const taskClaimsInFlight = new Set(); // guards against double-tap firing two claim requests per channel

async function handleDynamicTask(channelId) {
  const completed = currentUser.completed_channels || [];
  if (completed.includes(channelId)) { showToast('Already claimed!'); return; }
  if (taskClaimsInFlight.has(channelId)) return; // ignore extra taps while a claim is already running
  const ch = allChannels.find(c => c.id === channelId);
  if (!ch) return;

  if (!pendingVerify.has(channelId)) {
    // Step 1: open the channel
    const uname = (ch.name || '').replace('@', '');
    const link = `https://t.me/${uname}`;
    if (window.Telegram?.WebApp?.openTelegramLink) {
      Telegram.WebApp.openTelegramLink(link);
    } else {
      window.open(link, '_blank');
    }
    pendingVerify.add(channelId);
    renderDynamicTasks();
    return;
  }

  // Step 2: verify membership, then claim. Locked for the whole flow (not
  // just the membership check) so a fast double-tap can't fire a second
  // /api/user/task-reward request before the first has updated
  // currentUser.completed_channels and re-rendered the button as disabled.
  taskClaimsInFlight.add(channelId);
  renderDynamicTasks();

  try {
    const isMember = await checkChannelMembership(currentUser.id, ch.name);
    if (!isMember) {
      showToast("❌ You haven't joined yet");
      return;
    }

    const { reward, user } = await apiUser('/api/user/task-reward', { channel_id: channelId });
    currentUser.balance = user.balance;
    currentUser.total_earned = user.total_earned;
    currentUser.completed_channels = user.completed_channels;
    pendingVerify.delete(channelId);
    await renderUI();
    showToast(`🎉 +${reward.toLocaleString()} Milk!`);
  } catch (e) {
    console.error('Task reward error:', e);
    showToast('❌ Could not verify membership, try again');
  } finally {
    taskClaimsInFlight.delete(channelId);
    renderDynamicTasks();
  }
}

async function renderUI() {
  if (!currentUser) return;
  updateSpinBadge();
  
  document.getElementById('avatarInitial').textContent = currentUser.first_name[0].toUpperCase();
  document.getElementById('userName').textContent = currentUser.first_name;
  document.getElementById('mainBalance').textContent = currentUser.balance.toLocaleString();
  document.getElementById('totalEarned').textContent = (currentUser.total_earned || 0).toLocaleString();
  document.getElementById('tapCountDisplay').textContent = (currentUser.tap_count || 0).toLocaleString();
  document.getElementById('streakDisplay').textContent = currentUser.streak ?? 0;
  const alreadyClaimedTodayCheck = currentUser.last_claim && utcDateStr(currentUser.last_claim) === utcDateStr(new Date());
  const dailyTaskBtn = document.getElementById('dailyTaskClaimBtn');
  if (dailyTaskBtn) {
    dailyTaskBtn.textContent = alreadyClaimedTodayCheck ? '✅ Claimed' : 'Claim';
    dailyTaskBtn.classList.toggle('done', !!alreadyClaimedTodayCheck);
    dailyTaskBtn.disabled = !!alreadyClaimedTodayCheck;
  }
  document.getElementById('walletBalance').innerHTML = `${(currentUser.balance || 0).toLocaleString()} <span style="font-size:14px;color:var(--muted)">Milk</span>`;
  const usdtBal = (currentUser.usdt_balance || 0);
  document.getElementById('usdtBalance').textContent = usdtBal.toLocaleString(undefined, {maximumFractionDigits:4});
  document.getElementById('usdtBalanceSub').textContent = `${usdtBal.toLocaleString(undefined, {maximumFractionDigits:4})} USDT`;
  document.getElementById('refLink').textContent = `https://t.me/${BOT_USERNAME}/Play?startapp=${currentUser.id}`;
  document.getElementById('refCount').textContent = currentUser.referral_count || 0;
  const instantReward = appSettings.referral_instant_reward || 50;
  const adsBonusReward = appSettings.referral_ads_reward || 100;
  const totalReward = instantReward + adsBonusReward;
  const refEarned = (currentUser.referral_count || 0) * instantReward; // ads-bonus portion is per-friend and tracked via transactions, not multiplied here
  document.getElementById('earnedBonus').textContent = refEarned.toLocaleString();
  document.getElementById('refEarnedStat').textContent = refEarned.toLocaleString();
  document.getElementById('inviteTaskReward').textContent = '+' + totalReward.toLocaleString();
  document.getElementById('refDescText').textContent = `Get ${totalReward.toLocaleString()} Milk per friend — ${instantReward} instantly + ${adsBonusReward} more when they watch 10 ads!`;
  document.getElementById('refStep4Text').textContent = `You get +${instantReward.toLocaleString()} Milk instantly, then +${adsBonusReward.toLocaleString()} more once they watch 10 ads!`;

  // Tap card stats
  document.getElementById('tapCoinsEarned').textContent = (currentUser.tap_count || 0).toLocaleString();

  // Level bar (every 100 taps = 1 level)
  const tapCount = currentUser.tap_count || 0;
  const level = Math.floor(tapCount / 100) + 1;
  const progress = tapCount % 100;
  document.getElementById('levelLabel').textContent = `Level ${level}`;
  document.getElementById('levelProgress').textContent = `${progress}/100 taps`;
  document.getElementById('levelBarFill').style.width = `${progress}%`;

  // Tasks summary (rough estimate: total earned minus tap earnings)
  const taskEarned = Math.max(0, (currentUser.total_earned || 0) - tapCount);
  document.getElementById('tasksEarnedTotal').textContent = taskEarned.toLocaleString();

  // Ads watched progress
  const adsWatched = currentUser.ads_watched || 0;
  const adsToday = getTodayAdsWatched(currentUser);
  const dailyLimit = appSettings.ads_daily_limit || 10;
  const referralCount = currentUser.referral_count || 0;
  document.getElementById('adsProgress').textContent = `Today: ${adsToday}/${dailyLimit}`;
  document.getElementById('adRewardDisplay').textContent = '+' + (appSettings.ad_reward || 50);
  document.getElementById('mainChannelRewardDisplay').textContent = '+' + (appSettings.channel_reward || 1000).toLocaleString() + ' 🥛';

  // Daily task reward preview
  const rewards = getDailyRewards();
  const streakIdx = Math.min(currentUser.streak ?? 0, 6);
  document.getElementById('dailyTaskReward').textContent = '+' + rewards[streakIdx];

  // Channel task button state
  if (currentUser.channel_joined) {
    const btn = document.getElementById('task-channel-btn');
    btn.textContent = '✅ Done';
    btn.classList.add('done');
    btn.disabled = true;
  }
  
  // Render transactions
  try {
    const txns = await dbGet('transactions', `user_id=eq.${currentUser.id}&order=created_at.desc&limit=10`);
    let html = '';
    txns.forEach(t => {
      const icon = t.type === 'earn' ? '➕' : t.type === 'info' ? '✅' : '⬆️';
      const amountClass = t.type === 'info' ? 'plus' : (t.amount > 0 ? 'plus' : 'minus');
      const amountDisplay = t.type === 'info' ? '' : `${t.amount > 0 ? '+' : ''}${t.amount}`;
      html += `
        <div class="tx-item">
          <div class="tx-icon">${icon}</div>
          <div class="tx-info">
            <div class="tx-name">${t.description}</div>
            <div class="tx-time">${new Date(t.created_at).toLocaleDateString()}</div>
          </div>
          <div class="tx-amount ${amountClass}">${amountDisplay}</div>
        </div>
      `;
    });
    document.getElementById('txList').innerHTML = html || '<div class="tx-empty"><span class="icon">🥛</span>No transactions yet.</div>';
  } catch(e) {
    console.error('Render transactions error:', e);
  }
}

let nextTapAdAt = getRandomTapThreshold();
function getRandomTapThreshold() {
  return Math.floor(Math.random() * 11) + 20; // random between 20-30
}

// Returns the user's current usable tap energy, continuously regenerating over time
// (not just a one-time full recharge after hitting 0). tap_energy_depleted_at is reused
// as a "last checkpoint" timestamp from which partial regen is calculated.
function getTapEnergyState(user) {
  const maxEnergy = appSettings.tap_energy_max || 100;
  const cooldownMs = (appSettings.tap_cooldown_minutes || 30) * 60 * 1000; // time to regen 0 -> max
  const msPerPoint = cooldownMs / maxEnergy;

  const storedEnergy = user.tap_energy != null ? user.tap_energy : maxEnergy;
  const checkpoint = user.tap_energy_depleted_at ? new Date(user.tap_energy_depleted_at).getTime() : null;

  if (storedEnergy >= maxEnergy || !checkpoint) {
    return { energy: maxEnergy, rawEnergy: maxEnergy, checkpoint: null, maxEnergy, msPerPoint, full: true };
  }

  const elapsed = Date.now() - checkpoint;
  const regenerated = elapsed / msPerPoint;
  const rawEnergy = Math.min(maxEnergy, storedEnergy + regenerated);
  const energy = Math.floor(rawEnergy);
  const full = rawEnergy >= maxEnergy;
  const msToNextPoint = full ? 0 : msPerPoint - ((rawEnergy - energy) * msPerPoint);

  return { energy, rawEnergy, checkpoint: full ? null : checkpoint, maxEnergy, msPerPoint, msToNextPoint, full };
}

function updateTapEnergyDisplay() {
  if (!currentUser) return;
  const state = getTapEnergyState(currentUser);
  const box = document.getElementById('tapEnergyStatus');
  const btn = document.querySelector('.tap-btn');
  if (!box) return;

  // Only lock the value back into currentUser once fully regenerated (and clear the
  // checkpoint then). Never write the rounded in-between value back with the old
  // checkpoint still attached — that corrupts the baseline and double-counts elapsed
  // time on the next calculation, which is what was causing energy to stall instead
  // of climbing smoothly all the way from wherever it is up to max.
  if (state.full && currentUser.tap_energy_depleted_at) {
    currentUser.tap_energy = state.maxEnergy;
    currentUser.tap_energy_depleted_at = null;
  }

  const tapDailyLimit = appSettings.tap_daily_limit || 500;
  const tapsToday = getTodayTapsCount(currentUser);
  const dailyCapHit = tapsToday >= tapDailyLimit;

  box.textContent = dailyCapHit
    ? `🚫 Daily limit reached (${tapDailyLimit}/${tapDailyLimit}) — resets tomorrow`
    : `⚡ ${state.energy}/${state.maxEnergy} taps left`;
  if (btn) btn.disabled = dailyCapHit || (state.energy <= 0 && !state.full);
}

async function tapMilk(e) {
  if (!currentUser) return;

  const tapDailyLimit = appSettings.tap_daily_limit || 500;
  const today = todayISO();
  let tapsToday = getTodayTapsCount(currentUser);
  if (tapsToday >= tapDailyLimit) {
    showToast(`🚫 Daily tap limit reached (${tapDailyLimit}). Try again tomorrow!`);
    return;
  }

  const state = getTapEnergyState(currentUser);
  if (state.full) {
    currentUser.tap_energy = state.maxEnergy;
    currentUser.tap_energy_depleted_at = null;
  }
  if (state.energy <= 0 && !state.full) {
    updateTapEnergyDisplay();
    showToast(`⏳ Out of taps! Recharging...`);
    return;
  }

  // Optimistic local update — instant feedback. The network write happens in the
  // background, batched (see queueTapSync), so rapid tapping never waits on it.
  currentUser.balance += 1;
  currentUser.total_earned += 1;
  currentUser.tap_count = (currentUser.tap_count || 0) + 1;
  currentUser.taps_today = tapsToday + 1;
  currentUser.last_tap_date = today;
  const newEnergy = state.energy - 1;
  currentUser.tap_energy = newEnergy;
  currentUser.tap_energy_depleted_at = newEnergy < state.maxEnergy ? new Date().toISOString() : null;

  if (currentUser.taps_today >= tapDailyLimit) {
    showToast(`🚫 Daily tap limit reached (${tapDailyLimit}). Try again tomorrow!`);
  }

  createFloatingCoin(e);
  updateTapUI();
  updateTapEnergyDisplay();

  const newTapCount = currentUser.tap_count;
  if (newTapCount >= nextTapAdAt) {
    nextTapAdAt = newTapCount + getRandomTapThreshold();
    if (typeof show_11250385 === 'function') {
      show_11250385().catch(() => {}); // just show the ad, no reward tied to this one
    }
  }

  queueTapSync();
}

// Lightweight, network-free UI refresh for the numbers that change on every tap.
// (renderUI() also re-fetches the transaction history from the server on every call —
// running that on every single tap is what was making rapid tapping feel slow.)
function updateTapUI() {
  if (!currentUser) return;
  document.getElementById('mainBalance').textContent = currentUser.balance.toLocaleString();
  document.getElementById('walletBalance').innerHTML = `${(currentUser.balance || 0).toLocaleString()} <span style="font-size:14px;color:var(--muted)">Milk</span>`;
  document.getElementById('tapCountDisplay').textContent = (currentUser.tap_count || 0).toLocaleString();
  document.getElementById('tapCoinsEarned').textContent = (currentUser.tap_count || 0).toLocaleString();
  const tapCount = currentUser.tap_count || 0;
  const level = Math.floor(tapCount / 100) + 1;
  const progress = tapCount % 100;
  document.getElementById('levelLabel').textContent = `Level ${level}`;
  document.getElementById('levelProgress').textContent = `${progress}/100 taps`;
  document.getElementById('levelBarFill').style.width = `${progress}%`;
}

// --- Batched network sync for taps ---
// Instead of firing a DB update + transaction insert for every single tap (2 network
// round-trips each), we accumulate taps locally and sync them in one shot after a short
// pause, or once the batch gets large. A burst of 20 rapid taps now costs 1 round-trip
// instead of 40.
let pendingTapCount = 0;
let tapSyncTimer = null;
const TAP_SYNC_DEBOUNCE_MS = 700;
const TAP_SYNC_BATCH_SIZE = 15;

function queueTapSync() {
  pendingTapCount++;
  if (tapSyncTimer) clearTimeout(tapSyncTimer);
  if (pendingTapCount >= TAP_SYNC_BATCH_SIZE) {
    flushTapSync();
  } else {
    tapSyncTimer = setTimeout(flushTapSync, TAP_SYNC_DEBOUNCE_MS);
  }
}

async function flushTapSync() {
  if (tapSyncTimer) { clearTimeout(tapSyncTimer); tapSyncTimer = null; }
  const taps = pendingTapCount;
  if (taps <= 0 || !currentUser) return;
  pendingTapCount = 0;

  try {
    // Server recomputes energy/cooldown/daily-limit from the DB row and only
    // credits what's actually allowed - the client's optimistic local numbers
    // are just for instant UI feedback, never trusted as the source of truth.
    const { user, applied } = await apiUser('/api/user/tap', { count: taps });
    currentUser.balance = user.balance;
    currentUser.total_earned = user.total_earned;
    currentUser.tap_count = user.tap_count;
    currentUser.tap_energy = user.tap_energy;
    currentUser.tap_energy_depleted_at = user.tap_energy_depleted_at;
    currentUser.taps_today = user.taps_today;
    currentUser.last_tap_date = user.last_tap_date;
    if (applied < taps) {
      // Server capped it (energy ran out / daily limit hit mid-batch) -
      // reconcile the UI so it isn't showing more than was actually credited.
      updateTapUI();
      updateTapEnergyDisplay();
    }
  } catch(e) {
    console.error('Tap sync error:', e);
    pendingTapCount += taps; // retry these on the next flush instead of losing them
    // Schedule the retry ourselves - if this was the last tap in a burst, nothing
    // else would trigger queueTapSync again and these taps would just sit here
    // (and the UI would stay optimistically ahead of what the server actually has).
    if (!tapSyncTimer) tapSyncTimer = setTimeout(flushTapSync, TAP_SYNC_DEBOUNCE_MS);
  }
}

// Best-effort flush so a quick burst of taps isn't lost if the user leaves the page
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && pendingTapCount > 0) flushTapSync();
});
window.addEventListener('pagehide', () => { if (pendingTapCount > 0) flushTapSync(); });

// Keep the cooldown countdown fresh even if the user just waits on the Home screen
setInterval(() => { if (currentUser) updateTapEnergyDisplay(); }, 1000);

function createFloatingCoin(e) {
  const coin = document.createElement('div');
  coin.className = 'float-coin';
  coin.textContent = '+1';
  coin.style.left = (e?.clientX || window.innerWidth/2) + 'px';
  coin.style.top = (e?.clientY || window.innerHeight/2) + 'px';
  document.body.appendChild(coin);
  setTimeout(() => coin.remove(), 1000);
}

let channelJoinClicked = false;
let pendingVerify = new Set();

async function checkChannelMembership(userId, channelUsername) {
  // Calls our own backend, which holds the bot token server-side and checks
  // membership via Telegram Bot API - the token never touches the client.
  const chat = channelUsername || CHANNEL;
  const url = `${BACKEND_URL}/api/check-membership?chat=${encodeURIComponent(chat)}&user_id=${encodeURIComponent(userId)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return !!data.joined;
  } catch (e) {
    console.error('Membership check failed', e);
    return false;
  }
}

let channelClaimInFlight = false; // guards against double-tap firing two claim requests

async function joinChannel() {
  if (currentUser.channel_joined) { showToast('Already joined!'); return; }
  if (channelClaimInFlight) return; // ignore extra taps while a claim is already running

  const btn = document.getElementById('task-channel-btn');
  const hint = document.getElementById('task-channel-hint');

  if (!channelJoinClicked) {
    // Step 1: open the channel, ask user to actually join
    const link = `https://t.me/${CHANNEL.replace('@','')}`;
    if (window.Telegram?.WebApp?.openTelegramLink) {
      Telegram.WebApp.openTelegramLink(link);
    } else {
      window.open(link, '_blank');
    }
    channelJoinClicked = true;
    btn.textContent = 'Verify';
    if (hint) hint.style.display = 'block';
    return;
  }

  // Step 2: verify membership, then claim - button stays disabled for the
  // whole flow (not just the membership check) so a fast double-tap can't
  // fire a second /api/user/channel-reward request before the first one
  // has updated currentUser.channel_joined.
  channelClaimInFlight = true;
  btn.disabled = true;
  btn.textContent = 'Checking...';

  try {
    const isMember = await checkChannelMembership(currentUser.id);
    if (!isMember) {
      btn.textContent = 'Verify';
      showToast('❌ You haven\'t joined the channel yet');
      return;
    }

    const { reward, user } = await apiUser('/api/user/channel-reward', { chat: CHANNEL });
    currentUser.balance = user.balance;
    currentUser.total_earned = user.total_earned;
    currentUser.channel_joined = true;
    if (hint) hint.style.display = 'none';
    await renderUI();
    showToast(`🎉 +${reward.toLocaleString()} Milk!`);
  } catch (e) {
    console.error('Channel reward error:', e);
    btn.textContent = 'Verify';
    showToast('❌ Could not verify membership, try again');
  } finally {
    channelClaimInFlight = false;
    if (!currentUser.channel_joined) btn.disabled = false;
  }
}

let adRewardInFlight = false; // guards against double-tap firing two ad-reward claims
async function watchAd() {
  if (adRewardInFlight) return;
  const today = todayISO();
  if (currentUser.last_ad_date !== today) {
    currentUser.ads_watched_today = 0;
    currentUser.last_ad_date = today;
  }
  const limit = appSettings.ads_daily_limit || 10;
  if ((currentUser.ads_watched_today || 0) >= limit) {
    showToast(`⏰ Daily ad limit reached (${limit}/day). Come back tomorrow!`);
    return;
  }

  adRewardInFlight = true;
  const btn = document.getElementById('watchAdBtn');
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    await show_11250385(); // rewarded interstitial — resolves only if the ad was actually watched

    // Everything from here - daily-limit check, reward amount, the counters,
    // and the one-time referral ads-milestone bonus - is decided and applied
    // server-side in a single call. The client can no longer just PATCH its
    // own ads_watched/balance fields.
    const { reward, user, earnedSpinCredit } = await apiUser('/api/user/ad-reward', {});
    currentUser.ads_watched = user.ads_watched;
    currentUser.ads_watched_today = user.ads_watched_today;
    currentUser.last_ad_date = user.last_ad_date;
    currentUser.referral_bonus_paid = user.referral_bonus_paid;
    currentUser.balance = user.balance;
    currentUser.total_earned = user.total_earned;
    currentUser.ads_since_last_spin = user.ads_since_last_spin;
    currentUser.spin_credits = user.spin_credits;
    await renderUI();
    if (earnedSpinCredit) {
      showToast(`🎉 +${reward.toLocaleString()} Milk! 🎡 +1 Spin Credit!`);
    } else {
      showToast(`🎉 +${reward.toLocaleString()} Milk!`);
    }
  } catch (e) {
    console.error('Ad reward error:', e);
    showToast('❌ Ad was not completed, no reward');
  } finally {
    adRewardInFlight = false;
    btn.textContent = 'Watch';
    btn.disabled = false;
  }
}

// ===== USDT EXCHANGE (Withdraw) =====
// Binance UID has been removed - USDT (BEP20) is now the only withdrawal method.

const WITHDRAW_CFG = {
  unit: 'USDT',
  balanceField: 'usdt_balance',
  label: '💵 Your USDT Address (BEP20 - BSC Network)',
  placeholder: 'Enter your BEP20 (BSC) USDT address',
  minLen: 5,
};

function getMinWithdrawal() {
  return appSettings.min_withdrawal_usdt ?? 0.1;
}

const withdrawMethod = 'USDT_BEP20';

function setupWithdrawForm() {
  document.getElementById('gramAddressLabel').textContent = WITHDRAW_CFG.label;
  document.getElementById('gramAddress').placeholder = WITHDRAW_CFG.placeholder;
  document.getElementById('gramAddress').value = '';
  exchangeAmount = Math.min(getMinWithdrawal(), currentUser?.[WITHDRAW_CFG.balanceField] || 0) || getMinWithdrawal();
  renderQuickAmountButtons(getMinWithdrawal());
  refreshExchangeUI();
}



function openHistoryModal() {
  document.getElementById('historyModal').classList.add('open');
}

function openWithdrawModal() {
  if (!currentUser) { showToast('⏳ Please wait, loading your data...'); return; }
  setupWithdrawForm();
  document.getElementById('withdrawModal').classList.add('open');
}

// Quick-amount shortcut buttons scale with the admin-configured minimum
// withdrawal, shown as decimals since these are unit amounts, not Milk.
function renderQuickAmountButtons(minWithdrawal) {
  const row = document.getElementById('quickAmountsRow');
  if (!row) return;
  const amounts = [minWithdrawal, minWithdrawal * 5, minWithdrawal * 10];
  row.innerHTML = amounts.map(a => `<button onclick="setExchangeAmount(${a})">${a}</button>`).join('')
    + `<button onclick="setExchangeAmount('max')">MAX</button>`;
}

function setExchangeAmount(val) {
  if (val === 'max') {
    exchangeAmount = currentUser?.[WITHDRAW_CFG.balanceField] || 0;
  } else {
    exchangeAmount = val;
  }
  refreshExchangeUI();
}

// Fires as the user types directly into the amount field
function onExchangeAmountTyped(rawValue) {
  const parsed = parseFloat(rawValue);
  exchangeAmount = isNaN(parsed) || parsed < 0 ? 0 : parsed;
  refreshExchangeUI(true); // true = don't touch the input's own value while typing
}

function refreshExchangeUI(skipAmountFieldUpdate) {
  if (!currentUser) return;
  const adsToday = getTodayAdsWatched(currentUser);
  const referralCount = currentUser.referral_count || 0;
  const adsRequired = getAdsRequiredForWithdrawal();
  const referralsRequired = getReferralsRequiredForWithdrawal();
  const subtitleParts = [];
  if (adsRequired > 0) subtitleParts.push(`${adsRequired} Ads (Today)`);
  if (referralsRequired > 0) subtitleParts.push(`${referralsRequired} Invites Required`);
  const subtitleEl = document.getElementById('withdrawReqSubtitle');
  if (subtitleEl) subtitleEl.textContent = subtitleParts.length ? subtitleParts.join(' + ') : 'No extra requirements';
  const adsOk = !!currentUser.skip_ads_required || adsToday >= adsRequired;
  const referralsOk = !!currentUser.skip_referral_required || referralCount >= referralsRequired;
  const adsNeeded = Math.max(0, adsRequired - adsToday);
  const referralsNeeded = Math.max(0, referralsRequired - referralCount);

  const cfg = WITHDRAW_CFG;
  const minWithdrawal = getMinWithdrawal();
  const availableBalance = currentUser[cfg.balanceField] || 0;

  if (!skipAmountFieldUpdate) {
    document.getElementById('exchangeAmountDisplay').value = exchangeAmount;
  }
  document.getElementById('exchangeBalanceLabel').textContent = `Available: ${availableBalance.toFixed(4)} ${cfg.unit}`;
  document.getElementById('exchangeUnitLabel').textContent = `${cfg.unit} to withdraw`;
  document.getElementById('exchangeMinLabel').textContent = `${minWithdrawal} ${cfg.unit}`;

  const adsWarningBox = document.getElementById('adsWarningBox');
  const adsWarningTitle = document.getElementById('adsWarningTitle');
  const adsRequiredStatus = document.getElementById('adsRequiredStatus');
  const referralsRequiredStatus = document.getElementById('referralsRequiredStatus');

  adsRequiredStatus.textContent = adsOk ? '✅ Completed' : `❌ Need ${adsNeeded} more`;
  adsRequiredStatus.classList.toggle('bad', !adsOk);
  referralsRequiredStatus.textContent = referralsOk ? '✅ Completed' : `❌ Need ${referralsNeeded} more`;
  referralsRequiredStatus.classList.toggle('bad', !referralsOk);

  if (adsOk && referralsOk) {
    adsWarningBox.style.display = 'none';
  } else {
    adsWarningBox.style.display = 'block';
    const missing = [];
    if (!adsOk) missing.push(`watch ${adsNeeded} more ad${adsNeeded === 1 ? '' : 's'} today`);
    if (!referralsOk) missing.push(`invite ${referralsNeeded} more friend${referralsNeeded === 1 ? '' : 's'}`);
    adsWarningTitle.textContent = missing.length ? `You need to ${missing.join(' and ')}!` : '';
  }

  const addr = document.getElementById('gramAddress').value.trim();
  const validAmount = exchangeAmount >= minWithdrawal && exchangeAmount <= availableBalance;
  const canSubmit = adsOk && referralsOk && validAmount && addr.length >= cfg.minLen;
  document.getElementById('exchangeSubmitBtn').disabled = !canSubmit;
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'gramAddress') refreshExchangeUI();
});

let exchangeSubmitting = false;
async function confirmGramExchange() {
  if (exchangeSubmitting) return; // prevent double-tap duplicate withdrawals in history
  const adsToday = getTodayAdsWatched(currentUser);
  const referralCount = currentUser.referral_count || 0;
  const skipAds = !!currentUser.skip_ads_required;
  const skipReferral = !!currentUser.skip_referral_required;
  const addr = document.getElementById('gramAddress').value.trim();
  const cfg = WITHDRAW_CFG;
  const minWithdrawal = getMinWithdrawal();
  const availableBalance = currentUser[cfg.balanceField] || 0;

  if (!skipAds && adsToday < getAdsRequiredForWithdrawal()) { showToast(`❌ Watch ${getAdsRequiredForWithdrawal() - adsToday} more ads today first!`); return; }
  if (!skipReferral && referralCount < getReferralsRequiredForWithdrawal()) { showToast(`❌ Invite ${getReferralsRequiredForWithdrawal() - referralCount} more friend(s) first!`); return; }
  if (exchangeAmount < minWithdrawal) { showToast(`Min ${minWithdrawal} ${cfg.unit}`); return; }
  if (exchangeAmount > availableBalance) { showToast(`Insufficient ${cfg.unit} balance! Swap some Milk first.`); return; }
  if (!addr || addr.length < cfg.minLen) { showToast(`Invalid ${cfg.label.replace(/^\S+\s/, '')}!`); return; }

  exchangeSubmitting = true;
  const submitBtn = document.getElementById('exchangeSubmitBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ Submitting...'; }

  try {
    // Server re-checks balance and the ads/referral requirements itself
    // before creating the withdrawal and debiting balance - the UI checks
    // above are just so the button looks disabled, they enforce nothing.
    const { user } = await apiUser('/api/user/withdraw', {
      amount: exchangeAmount,
      wallet_address: addr,
      method: withdrawMethod,
    });
    currentUser.gram_balance = user.gram_balance;
    currentUser.usdt_balance = user.usdt_balance;
    closeModal('withdrawModal');
    document.getElementById('gramAddress').value = '';
    await renderUI();
    showToast(`✅ Withdrawal submitted! ${exchangeAmount} ${cfg.unit} pending.`);
  } catch (e) {
    console.error('Withdraw error:', e);
    showToast(`❌ ${e.message || 'Withdrawal failed'}`);
  } finally {
    exchangeSubmitting = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💎 Exchange & Withdraw'; }
  }
}

// ===== MILK SWAP (internal conversion to USDT balance) =====

const swapTarget = 'USDT'; // GRAM has been removed - swap only converts Milk -> USDT now
let swapAmount = MIN_SWAP_MILK;

function getMinSwapMilk() {
  return appSettings.min_swap_usdt_milk ?? MIN_SWAP_MILK;
}

function setSwapAmount(val) {
  if (!currentUser) return;
  swapAmount = val === 'max' ? (currentUser.balance || 0) : val;
  refreshSwapUI();
}

function openSwapModal() {
  if (!currentUser) { showToast('⏳ Please wait, loading your data...'); return; }
  swapAmount = Math.min(getMinSwapMilk(), currentUser.balance || 0) || getMinSwapMilk();
  refreshSwapUI();
  document.getElementById('swapModal').classList.add('open');
}

function refreshSwapUI(skipAmountFieldUpdate) {
  if (!currentUser) return;
  const rate = MILK_PER_USDT;
  const result = swapAmount / rate;

  // Don't overwrite the input while the user is actively typing in it (would
  // reset cursor position / fight with their keystrokes).
  if (!skipAmountFieldUpdate) {
    document.getElementById('swapAmountDisplay').value = swapAmount;
  }
  document.getElementById('swapResultDisplay').textContent = result.toFixed(4);
  document.getElementById('swapRateInfoLabel').textContent = `100,000 Milk = 1 USDT`;
  document.getElementById('swapMilkBalanceLabel').textContent = `${(currentUser.balance || 0).toLocaleString()}`;

  const validAmount = swapAmount >= getMinSwapMilk() && swapAmount <= (currentUser.balance || 0);
  document.getElementById('swapSubmitBtn').disabled = !validAmount;
}

// Fires as the user types directly into the Send amount field
function onSwapAmountTyped(rawValue) {
  const parsed = parseInt(rawValue, 10);
  swapAmount = isNaN(parsed) || parsed < 0 ? 0 : parsed;
  refreshSwapUI(true); // true = don't touch the input's own value while typing
}

let swapSubmitting = false;
async function confirmSwap() {
  if (swapSubmitting) return;
  if (swapAmount < getMinSwapMilk()) { showToast(`Min ${getMinSwapMilk().toLocaleString()} Milk`); return; }
  if (swapAmount > currentUser.balance) { showToast('Insufficient Milk balance!'); return; }

  swapSubmitting = true;
  const submitBtn = document.getElementById('swapSubmitBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ Swapping...'; }

  try {
    // Server re-checks balance and performs the Milk debit + USDT credit
    // atomically - the UI checks above enforce nothing on their own.
    const { user } = await apiUser('/api/user/swap', {
      amount: swapAmount,
      target: swapTarget,
    });
    currentUser.balance = user.balance;
    currentUser.usdt_balance = user.usdt_balance;
    closeModal('swapModal');
    await renderUI();
    showToast(`✅ Swapped! +${(swapAmount / MILK_PER_USDT).toFixed(4)} USDT`);
  } catch (e) {
    console.error('Swap error:', e);
    showToast(`❌ ${e.message || 'Swap failed'}`);
  } finally {
    swapSubmitting = false;
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '🔄 Swap Now'; }
  }
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'swapAmountDisplay') refreshSwapUI();
});

function openDailyModal() {
  const rewards = getDailyRewards();
  const completedDays = currentUser.streak ?? 0; // number of consecutive days already claimed
  const streak = Math.min(completedDays, 6);
  const reward = rewards[streak];
  document.getElementById('dailyRewardAmount').textContent = '+' + reward;
  const today = utcDateStr(new Date());
  const lastClaim = currentUser.last_claim ? utcDateStr(currentUser.last_claim) : null;
  const claimed = lastClaim === today;
  document.getElementById('dailyRewardLabel').textContent = claimed ? 'Already claimed today!' : 'Claim daily reward!';
  document.getElementById('dailyClaimBtn').disabled = claimed;
  document.getElementById('dailyClaimBtn').style.opacity = claimed ? '0.5' : '1';
  
  const el = document.getElementById('streakDays');
  el.innerHTML = Array.from({length:7},(_,i) => {
    const cls = i < completedDays ? 'done' : i === completedDays ? 'today' : '';
    return `<div class="streak-day ${cls}">${i+1}</div>`;
  }).join('');
  document.getElementById('streakCount').textContent = completedDays;
  document.getElementById('dailyModal').classList.add('open');
}

let dailyClaimSubmitting = false; // prevent double-tap duplicate entries in history
async function claimDaily() {
  if (dailyClaimSubmitting) return;

  const today = utcDateStr(new Date());
  const lastClaim = currentUser.last_claim ? utcDateStr(currentUser.last_claim) : null;
  if (lastClaim === today) { showToast('Already claimed!'); return; }

  dailyClaimSubmitting = true;
  const claimBtn = document.getElementById('dailyClaimBtn');
  if (claimBtn) { claimBtn.disabled = true; claimBtn.style.opacity = '0.5'; }

  try {
    // Server checks "already claimed today?" and computes the streak/reward
    // itself, so replaying this request can't double-credit.
    const { reward, user } = await apiUser('/api/user/daily-claim', {});
    currentUser.balance = user.balance;
    currentUser.total_earned = user.total_earned;
    currentUser.streak = user.streak;
    currentUser.last_claim = user.last_claim;

    closeModal('dailyModal');
    await renderUI();
    showToast(`🎁 +${reward} Milk!`);
  } catch(e) {
    console.error('Claim daily error:', e);
    showToast(`❌ ${e.message || 'Error claiming reward'}`);
  } finally {
    dailyClaimSubmitting = false;
    if (claimBtn) { claimBtn.disabled = false; claimBtn.style.opacity = '1'; }
  }
}

// ===== SPIN WHEEL =====
// Same fallback list as the backend's DEFAULT_SPIN_PRIZES - used only until
// the admin has saved a custom spin_prizes list in Settings, so the wheel
// never renders empty on a fresh install.
const SPIN_PRIZES_FALLBACK = [
  { type: 'MILK', amount: 100, weight: 40 },
  { type: 'MILK', amount: 500, weight: 20 },
  { type: 'MILK', amount: 1000, weight: 10 },
  { type: 'USDT', amount: 0.01, weight: 30 },
];
const SPIN_SEGMENT_COLORS = ['#a855f7', '#7c3aed', '#c026d3', '#9333ea', '#8b5cf6', '#6d28d9', '#d946ef', '#4c1d95'];

function getSpinPrizes() {
  return (Array.isArray(appSettings.spin_prizes) && appSettings.spin_prizes.length)
    ? appSettings.spin_prizes
    : SPIN_PRIZES_FALLBACK;
}

// ---- Admin panel: Spin Wheel prize list builder ----
function renderSpinPrizesBuilder() {
  const container = document.getElementById('spinPrizesBuilder');
  if (!container) return;
  const prizes = getSpinPrizes();
  container.innerHTML = prizes.map((p, i) => spinPrizeRowHtml(p, i)).join('');
}

function spinPrizeRowHtml(p, i) {
  return `<div class="spin-prize-row" style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px;padding:8px;border:1px solid var(--border);border-radius:10px;" data-idx="${i}">
    <div style="display:flex;gap:6px;align-items:center;">
      <select class="spin-prize-type" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:#181029;color:var(--fg);font-family:inherit;">
        <option value="MILK" ${p.type === 'MILK' ? 'selected' : ''}>🥛 Milk</option>
        <option value="USDT" ${p.type === 'USDT' ? 'selected' : ''}>💵 USDT</option>
      </select>
      <input class="spin-prize-amount" type="number" step="any" value="${p.amount}" placeholder="Amount" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:#181029;color:var(--fg);">
      <input class="spin-prize-weight" type="number" value="${p.weight}" placeholder="Weight" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--border);background:#181029;color:var(--fg);">
      <button type="button" class="btn-mini-red" onclick="this.closest('.spin-prize-row').remove()">✕</button>
    </div>
    <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);cursor:pointer;">
      <input type="checkbox" class="spin-prize-display-only" ${p.display_only ? 'checked' : ''}>
      Display only — shows on the wheel for excitement, never actually awarded
    </label>
  </div>`;
}

function addSpinPrizeRow() {
  const container = document.getElementById('spinPrizesBuilder');
  container.insertAdjacentHTML('beforeend', spinPrizeRowHtml({ type: 'MILK', amount: 100, weight: 10 }, container.children.length));
}

// Reads the current state of every prize row in the admin builder into the
// array shape the backend expects ({type, amount, weight}).
function collectSpinPrizesFromForm() {
  const rows = document.querySelectorAll('#spinPrizesBuilder .spin-prize-row');
  const prizes = [];
  rows.forEach(row => {
    const type = row.querySelector('.spin-prize-type').value;
    const amount = parseFloat(row.querySelector('.spin-prize-amount').value);
    const weight = parseFloat(row.querySelector('.spin-prize-weight').value);
    const displayOnly = row.querySelector('.spin-prize-display-only').checked;
    if (!isNaN(amount) && !isNaN(weight) && weight > 0) {
      prizes.push({ type, amount, weight, display_only: displayOnly });
    }
  });
  return prizes.length ? prizes : SPIN_PRIZES_FALLBACK;
}

function getAvailableSpins() {
  if (!currentUser) return 0;
  const today = utcDateStr(new Date());
  const freeAvailable = currentUser.last_spin_date !== today ? 1 : 0;
  return freeAvailable + (currentUser.spin_credits || 0);
}

// Rebuilds the wheel's visual segments (equal-sized slices, one per prize
// entry - visual size is NOT weighted, since a spin wheel showing a tiny
// sliver for a 40%-weighted common prize would look broken; the actual odds
// are still fully weighted server-side in pickWeightedPrize()).
function renderSpinWheel() {
  const prizes = getSpinPrizes();
  const wheel = document.getElementById('spinWheel');
  const segAngle = 360 / prizes.length;
  const stops = prizes.map((p, i) => {
    const color = SPIN_SEGMENT_COLORS[i % SPIN_SEGMENT_COLORS.length];
    return `${color} ${i * segAngle}deg ${(i + 1) * segAngle}deg`;
  }).join(', ');
  wheel.style.background = `conic-gradient(${stops})`;
  wheel.style.transition = 'none';
  wheel.style.transform = 'rotate(0deg)';

  // Label spans, one per segment, rotated to point outward from center.
  // USDT uses the SAME real icon image as the Wallet screen (not emoji,
  // which doesn't match the actual Tether branding); Milk keeps the emoji
  // since there's no dedicated Milk icon asset.
  wheel.innerHTML = prizes.map((p, i) => {
    const midAngle = segAngle * i + segAngle / 2;
    const iconHtml = p.type === 'MILK'
      ? '<span style="font-size:16px;">🥛</span>'
      : `<div class="token-icon icon-${p.type.toLowerCase()}" style="width:18px;height:18px;margin:0 auto;"></div>`;
    return `<div style="position:absolute;top:50%;left:50%;width:0;height:0;transform:rotate(${midAngle}deg);">
      <div style="position:absolute;top:-105px;left:-30px;width:60px;text-align:center;transform:rotate(0deg);color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,0.6);">
        ${iconHtml}<br>${p.amount}
      </div>
    </div>`;
  }).join('');
  // Force reflow so the next spin's transition re-applies from rotate(0deg)
  // instead of jumping instantly (browsers batch style changes otherwise).
  void wheel.offsetWidth;
  wheel.style.transition = 'transform 4.2s cubic-bezier(0.12,0.67,0.1,0.99)';
}

function updateSpinBadge() {
  const available = getAvailableSpins();
  const countEl = document.getElementById('spinBadgeCount');
  const badgeBtn = document.getElementById('spinBadgeBtn');
  if (!countEl || !badgeBtn) return;
  countEl.textContent = available > 0 ? ` (${available})` : '';
  badgeBtn.style.opacity = available > 0 ? '1' : '0.6';
}

function openSpinModal() {
  if (!currentUser) { showToast('⏳ Please wait, loading your data...'); return; }
  renderSpinWheel();
  const available = getAvailableSpins();
  document.getElementById('spinAvailableLabel').textContent = available > 0
    ? `${available} spin${available === 1 ? '' : 's'} available`
    : 'No spins left — watch ads or come back tomorrow!';
  const btn = document.getElementById('spinNowBtn');
  btn.disabled = available <= 0;
  btn.style.opacity = available <= 0 ? '0.5' : '1';
  btn.textContent = 'SPIN NOW';
  document.getElementById('spinModal').classList.add('open');
}

let spinSubmitting = false;
async function spinNow() {
  if (spinSubmitting) return;
  if (getAvailableSpins() <= 0) { showToast('❌ No spins available!'); return; }

  spinSubmitting = true;
  const btn = document.getElementById('spinNowBtn');
  btn.disabled = true;
  btn.style.opacity = '0.5';
  btn.textContent = '🎡 Spinning...';

  try {
    // Server picks the prize and consumes the spin - the wheel animation
    // below is purely visual, landing on whatever prize the server already
    // decided, so there's no way to game the wheel by reading client state.
    const { prize, user } = await apiUser('/api/user/spin', {});

    const prizes = getSpinPrizes();
    let idx = prizes.findIndex(p => p.type === prize.type && Number(p.amount) === Number(prize.amount));
    if (idx === -1) idx = 0;
    const segAngle = 360 / prizes.length;
    const targetAngle = 360 * 6 + (360 - (idx * segAngle + segAngle / 2)); // 6 full spins + land on segment center
    const wheel = document.getElementById('spinWheel');
    wheel.style.transform = `rotate(${targetAngle}deg)`;

    await new Promise(resolve => setTimeout(resolve, 4300)); // matches the 4.2s CSS transition

    currentUser.balance = user.balance;
    currentUser.gram_balance = user.gram_balance;
    currentUser.usdt_balance = user.usdt_balance;
    currentUser.total_earned = user.total_earned;
    currentUser.last_spin_date = user.last_spin_date;
    currentUser.spin_credits = user.spin_credits;

    const unitIcon = { MILK: '🥛', USDT: '💵' };
    showToast(`🎉 You won ${prize.amount} ${unitIcon[prize.type] || ''} ${prize.type}!`);
    await renderUI();

    const available = getAvailableSpins();
    document.getElementById('spinAvailableLabel').textContent = available > 0
      ? `${available} spin${available === 1 ? '' : 's'} available`
      : 'No spins left — watch ads or come back tomorrow!';
    btn.disabled = available <= 0;
    btn.style.opacity = available <= 0 ? '0.5' : '1';
    btn.textContent = 'SPIN NOW';
  } catch (e) {
    console.error('Spin error:', e);
    showToast(`❌ ${e.message || 'Spin failed'}`);
    btn.textContent = 'SPIN NOW';
    btn.disabled = getAvailableSpins() <= 0;
    btn.style.opacity = btn.disabled ? '0.5' : '1';
  } finally {
    spinSubmitting = false;
  }
}


function copyRef() {
  const link = document.getElementById('refLink').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(() => showToast('✅ Copied!'));
  } else {
    const el = document.createElement('textarea');
    el.value = link;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('✅ Copied!');
  }
}

function shareRef() {
  const link = document.getElementById('refLink').textContent;
  const text = encodeURIComponent('🥛 Join Milky Rush and earn free Milk! Tap, complete tasks and exchange for USDT.');
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`;
  if (window.Telegram?.WebApp?.openTelegramLink) {
    Telegram.WebApp.openTelegramLink(shareUrl);
  } else {
    window.open(shareUrl, '_blank');
  }
}

// UTILS
let lastNavAdTime = 0;
function showPage(id, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  if (btn) btn.classList.add('active');

  // Make sure the Wallet's balance & transaction history reflect the latest taps,
  // even if a batch hasn't synced to the server yet.
  if (id === 'wallet') {
    if (typeof flushTapSync === 'function' && pendingTapCount > 0) {
      flushTapSync().then(() => renderUI());
    } else {
      renderUI();
    }
  }

  // Occasional interstitial on tab switch (not tied to reward), max once per 45s
  const now = Date.now();
  if (typeof show_11250385 === 'function' && now - lastNavAdTime > 45000 && Math.random() < 0.35) {
    lastNavAdTime = now;
    show_11250385().catch(() => {});
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// =============================
// ADMIN PANEL FUNCTIONS
// =============================

function openAdminPanel() {
  document.getElementById('userApp').style.display = 'none';
  document.getElementById('adminMode').classList.add('active');
  loadAdminData();
}

function closeAdminPanel() {
  document.getElementById('adminMode').classList.remove('active');
  document.getElementById('userApp').style.display = 'block';
}

async function loadAdminData() {
  try {
    const users = await dbGetAll('users');
    const txns = await dbGet('transactions', 'limit=50&order=created_at.desc');
    const withdrawals = await dbGet('withdrawals');
    
    // DASHBOARD STATS
    const totalEarned = users.reduce((s, u) => s + (u.total_earned || 0), 0);
    const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;
    
    document.getElementById('adminTotalUsers').textContent = users.length;
    document.getElementById('adminTotalEarned').textContent = totalEarned.toLocaleString();
    document.getElementById('adminPendingWithdrawals').textContent = pendingWithdrawals;
    document.getElementById('adminActiveChannels').textContent = allChannels.length;
    
    // TRANSACTIONS
    let txnHTML = '';
    txns.slice(0, 20).forEach(t => {
      txnHTML += `<tr>
        <td>${t.type === 'earn' ? '➕' : '⬆️'}</td>
        <td>${t.user_id}</td>
        <td>${t.description.substring(0, 20)}</td>
        <td style="color:${t.amount > 0 ? 'var(--green)' : 'var(--red)'}">${t.amount > 0 ? '+' : ''}${t.amount}</td>
        <td>${new Date(t.created_at).toLocaleDateString()}</td>
      </tr>`;
    });
    document.getElementById('adminTxnList').innerHTML = txnHTML;
    
    // CHANNELS
    let channelHTML = '';
    allChannels.forEach(c => {
      channelHTML += `<tr>
        <td>${c.icon || '📢'}</td>
        <td>${escapeHtml(c.name)}</td>
        <td>+${c.reward}</td>
        <td>${escapeHtml(c.type)}</td>
        <td>
          <button class="admin-btn danger" style="font-size:11px;" onclick="deleteChannel(${c.id})">X</button>
        </td>
      </tr>`;
    });
    if (allChannels.length === 0) {
      channelHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);">No channels</td></tr>';
    }
    document.getElementById('adminChannelsList').innerHTML = channelHTML;
    
    // USERS (cached for search/filter + bulk actions)
    allUsersCache = users;
    renderUsersTable();

    // WITHDRAWALS
    allWithdrawalsCache = withdrawals;
    let withdrawalHTML = '';
    const methodLabels = { GRAM: '💎 GRAM', USDT_BEP20: '💵 USDT (BEP20)', BINANCE_UID: '🅱️ Binance UID' };
    withdrawals.forEach(w => {
      withdrawalHTML += `<tr>
        <td>${w.user_id}</td>
        <td>${w.amount}</td>
        <td>${methodLabels[w.method] || '💎 GRAM'}</td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(w.wallet_address)}">${escapeHtml(w.wallet_address)}
          <button class="row-actions btn-mini-blue" style="border:none;border-radius:6px;padding:3px 6px;cursor:pointer;margin-left:4px;" onclick="copyWithdrawAddressById(${w.id})">📋</button>
        </td>
        <td><span style="background:${w.status === 'pending' ? 'rgba(250,176,0,0.3)' : 'rgba(34,211,160,0.3)'};color:${w.status === 'pending' ? '#fab000' : 'var(--green)'};padding:4px 8px;border-radius:4px;font-size:11px;font-weight:600;">${w.status.toUpperCase()}</span></td>
        <td>
          ${w.status === 'pending' ? `
            <button style="background:rgba(34,211,160,0.3);color:var(--green);border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:10px;margin-right:4px;" onclick="approveWithdrawal(${w.id})">OK</button>
            <button style="background:rgba(244,63,94,0.3);color:var(--red);border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:10px;" onclick="rejectWithdrawal(${w.id})">X</button>
          ` : '-'}
        </td>
      </tr>`;
    });
    document.getElementById('adminWithdrawalsList').innerHTML = withdrawalHTML;

    // SETTINGS
    document.getElementById('settingAdReward').value = appSettings.ad_reward;
    document.getElementById('settingAdsDailyLimit').value = appSettings.ads_daily_limit;
    document.getElementById('settingReferralInstant').value = appSettings.referral_instant_reward;
    document.getElementById('settingReferralAdsBonus').value = appSettings.referral_ads_reward;
    document.getElementById('settingMinWithdrawalUsdt').value = appSettings.min_withdrawal_usdt;
    document.getElementById('settingMinSwapUsdt').value = appSettings.min_swap_usdt_milk;
    document.getElementById('settingSpinAdsRequired').value = appSettings.spin_ads_required;
    renderSpinPrizesBuilder();
    document.getElementById('settingDailyRewardBase').value = appSettings.daily_reward_base;
    document.getElementById('settingChannelReward').value = appSettings.channel_reward;
    document.getElementById('settingTapEnergyMax').value = appSettings.tap_energy_max;
    document.getElementById('settingTapCooldown').value = appSettings.tap_cooldown_minutes;
    document.getElementById('settingTapDailyLimit').value = appSettings.tap_daily_limit;
    document.getElementById('settingWithdrawAdsRequired').value = appSettings.withdrawal_ads_required;
    document.getElementById('settingWithdrawAdsEnabled').checked = appSettings.withdrawal_ads_enabled !== false;
    document.getElementById('settingWithdrawReferralsRequired').value = appSettings.withdrawal_referrals_required;
    document.getElementById('settingWithdrawReferralsEnabled').checked = appSettings.withdrawal_referrals_enabled !== false;
    
  } catch(e) {
    console.error('Admin load error:', e);
    showToast('⚠️ Error loading admin data');
  }
}

function renderUsersTable() {
  const search = (document.getElementById('adminUserSearch')?.value || '').toLowerCase().trim();
  const filtered = allUsersCache.filter(u => {
    if (!search) return true;
    return String(u.id).includes(search) || (u.first_name || '').toLowerCase().includes(search) || (u.username || '').toLowerCase().includes(search);
  });
  document.getElementById('adminUserCount').textContent = allUsersCache.length;

  let userHTML = '';
  filtered.forEach(u => {
    const isBanned = !!u.banned;
    const skipAds = !!u.skip_ads_required;
    const skipRef = !!u.skip_referral_required;
    const usdtBal = u.usdt_balance || 0;
    userHTML += `<tr>
      <td>${u.id}</td>
      <td>${escapeHtml(u.first_name)}</td>
      <td>${(u.balance || 0).toLocaleString()}</td>
      <td>${usdtBal.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
      <td>${(u.total_earned || 0).toLocaleString()}</td>
      <td>${escapeHtml(u.reg_ip || '—')}</td>
      <td><span class="badge-status ${isBanned ? 'banned' : 'active'}">${isBanned ? 'BANNED' : 'ACTIVE'}</span></td>
      <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : 'N/A'}</td>
      <td>
        <div class="row-actions">
          <button class="btn-mini-blue" onclick="openUserDetails(${u.id})">👁 View</button>
          <button class="btn-mini-blue" onclick="openAdjustBalance(${u.id}, '${escapeHtml((u.first_name||'').replace(/'/g,""))}', ${u.balance || 0}, ${usdtBal})">💰 Add/Sub</button>
          <button class="${isBanned ? 'btn-mini-green' : 'btn-mini-red'}" onclick="toggleBan(${u.id}, ${isBanned})">${isBanned ? 'Unban' : 'Ban'}</button>
          <button class="${skipAds ? 'btn-mini-green' : 'btn-mini-blue'}" title="Skip the 10-ads-today withdrawal requirement for this user" onclick="toggleSkipAds(${u.id}, ${skipAds})">${skipAds ? '✅ Ads Skip' : '🚫 Ads Skip'}</button>
          <button class="${skipRef ? 'btn-mini-green' : 'btn-mini-blue'}" title="Skip the 3-invites withdrawal requirement for this user" onclick="toggleSkipReferral(${u.id}, ${skipRef})">${skipRef ? '✅ Ref Skip' : '🚫 Ref Skip'}</button>
        </div>
      </td>
    </tr>`;
  });
  if (filtered.length === 0) {
    userHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);">No users found</td></tr>';
  }
  document.getElementById('adminUsersList').innerHTML = userHTML;
}

function copyWithdrawAddress(addr) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(addr).then(() => showToast('✅ Address copied!'));
  } else {
    showToast('✅ ' + addr);
  }
}

// Safe wrapper for the withdrawals table button - only a numeric withdrawal ID
// is ever embedded in the onclick attribute (never the raw user-typed address),
// so a malicious wallet_address string can't break out of the HTML/JS context.
function copyWithdrawAddressById(id) {
  const w = allWithdrawalsCache.find(w => w.id === id);
  if (w) copyWithdrawAddress(w.wallet_address);
}

// Shows one user's full profile stats + complete transaction history (not
// just the last-50 global feed on the Transactions tab), so the admin can
// see exactly how a specific person's balance grew - taps vs ads vs
// referrals vs manual adjustments - and in what order.
async function openUserDetails(userId) {
  const user = allUsersCache.find(u => u.id === userId);
  if (!user) { showToast('❌ User not found'); return; }

  document.getElementById('userDetailTitle').textContent = `👤 ${user.first_name || 'User'} (ID: ${user.id})`;
  document.getElementById('userDetailBalance').textContent = (user.balance || 0).toLocaleString();
  document.getElementById('userDetailEarned').textContent = (user.total_earned || 0).toLocaleString();
  document.getElementById('userDetailTaps').textContent = (user.tap_count || 0).toLocaleString();
  document.getElementById('userDetailAds').textContent = (user.ads_watched || 0).toLocaleString();
  document.getElementById('userDetailRefs').textContent = (user.referral_count || 0).toLocaleString();
  document.getElementById('userDetailStreak').textContent = user.streak ?? 0;
  document.getElementById('userDetailTxnList').innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted);">Loading...</td></tr>';
  document.getElementById('userDetailModal').classList.add('open');

  try {
    // dbGetAll pages past Supabase's row cap so a heavy user's full history
    // (not just the first page) actually shows up here.
    const txns = await dbGetAll('transactions', `user_id=eq.${userId}&order=created_at.desc`);
    document.getElementById('userDetailTxnCount').textContent = txns.length;
    if (!txns.length) {
      document.getElementById('userDetailTxnList').innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--muted);">No transactions yet</td></tr>';
      return;
    }
    document.getElementById('userDetailTxnList').innerHTML = txns.map(t => `
      <tr>
        <td>${escapeHtml(t.description || '')}</td>
        <td style="color:${t.amount > 0 ? 'var(--green)' : 'var(--red)'}">${t.amount > 0 ? '+' : ''}${t.amount}</td>
        <td>${new Date(t.created_at).toLocaleString()}</td>
      </tr>`).join('');
  } catch (e) {
    console.error('Load user transactions error:', e);
    document.getElementById('userDetailTxnList').innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--red);">Failed to load transactions</td></tr>';
  }
}

// Cache of the currently-open user's balances per currency, so switching
// the currency dropdown can update the "Current: X" label without another
// network round-trip.
let adjustBalanceBalances = { milk: 0, usdt: 0 };
let adjustBalanceName = '';

function openAdjustBalance(userId, name, balance, usdtBalance) {
  adjustBalanceTargetId = userId;
  adjustBalanceName = name || 'User';
  adjustBalanceBalances = { milk: balance || 0, usdt: usdtBalance || 0 };
  document.getElementById('adjustBalanceCurrency').value = 'milk';
  document.getElementById('adjustBalanceAmount').value = '';
  document.getElementById('adjustBalanceDescription').value = '';
  updateAdjustBalanceLabel();
  document.getElementById('adjustBalanceModal').classList.add('open');
}

// Currency-specific display: unit label, current balance, and decimal
// precision (Milk is whole numbers, USDT carries decimals since it's
// converted at MILK_PER_USDT rate).
const ADJUST_BALANCE_UNITS = {
  milk: { label: 'Milk', icon: '🥛' },
  usdt: { label: 'USDT', icon: '💵' },
};
function updateAdjustBalanceLabel() {
  const currency = document.getElementById('adjustBalanceCurrency').value;
  const unit = ADJUST_BALANCE_UNITS[currency];
  const current = adjustBalanceBalances[currency] || 0;
  const currentStr = currency === 'milk' ? current.toLocaleString() : current.toLocaleString(undefined, {maximumFractionDigits:4});
  document.getElementById('adjustBalanceUserLabel').textContent = `${adjustBalanceName} (ID: ${adjustBalanceTargetId}) — Current: ${currentStr} ${unit.label}`;
  document.getElementById('adjustBalanceAmountLabel').textContent = `Amount (${unit.icon} ${unit.label}) — always positive, pick Add or Subtract below`;
}

let adjustBalanceSubmitting = false;
async function submitAdjustBalance(direction) {
  if (adjustBalanceSubmitting) return; // prevent double-tap duplicate entries in history
  const currency = document.getElementById('adjustBalanceCurrency').value;
  // Milk is whole-number only; USDT allows decimals (it's stored as a
  // fractional amount, e.g. 0.25 USDT).
  const rawAmount = currency === 'milk'
    ? parseInt(document.getElementById('adjustBalanceAmount').value)
    : parseFloat(document.getElementById('adjustBalanceAmount').value);
  if (!rawAmount || rawAmount <= 0) { showToast('❌ Enter a positive amount'); return; }
  const description = document.getElementById('adjustBalanceDescription').value.trim();
  adjustBalanceSubmitting = true;
  try {
    await adminApi(`/api/admin/users/${adjustBalanceTargetId}/balance`, { direction, amount: rawAmount, description, currency });
    closeModal('adjustBalanceModal');
    loadAdminData();
    showToast('✅ Balance updated!');
  } catch(e) {
    console.error('Adjust balance error:', e);
    showToast('❌ Error updating balance');
  } finally {
    adjustBalanceSubmitting = false;
  }
}

async function toggleBan(userId, isCurrentlyBanned) {
  const newState = !isCurrentlyBanned;
  if (!confirm(newState ? 'Ban this user?' : 'Unban this user?')) return;
  try {
    await adminApi(`/api/admin/users/${userId}/ban`, { banned: newState });
    loadAdminData();
    showToast(newState ? '🚫 User banned' : '✅ User unbanned');
  } catch(e) {
    console.error('Toggle ban error:', e);
    showToast('❌ Error updating ban status');
  }
}

async function toggleSkipAds(userId, isCurrentlySkipped) {
  const newState = !isCurrentlySkipped;
  try {
    await adminApi(`/api/admin/users/${userId}/skip-ads`, { skip: newState });
    if (currentUser && currentUser.id === userId) currentUser.skip_ads_required = newState;
    loadAdminData();
    showToast(newState ? '✅ This user can withdraw without the 10-ads-today requirement' : '🚫 Ads requirement re-enabled for this user');
  } catch(e) {
    console.error('Toggle skip-ads error:', e);
    showToast('❌ Error updating ads requirement');
  }
}

async function toggleSkipReferral(userId, isCurrentlySkipped) {
  const newState = !isCurrentlySkipped;
  try {
    await adminApi(`/api/admin/users/${userId}/skip-referral`, { skip: newState });
    if (currentUser && currentUser.id === userId) currentUser.skip_referral_required = newState;
    loadAdminData();
    showToast(newState ? '✅ This user can withdraw without the 3-invites requirement' : '🚫 Invite requirement re-enabled for this user');
  } catch(e) {
    console.error('Toggle skip-referral error:', e);
    showToast('❌ Error updating invite requirement');
  }
}

let bulkAddSubmitting = false;
async function bulkAddBalance() {
  if (bulkAddSubmitting) return; // prevent double-tap duplicate entries in history
  const amount = parseInt(document.getElementById('bulkBalanceAmount').value);
  if (!amount) { showToast('❌ Enter a valid amount'); return; }
  if (!confirm(`Add ${amount} Milk to ALL ${allUsersCache.length} users?`)) return;
  bulkAddSubmitting = true;
  showToast('⏳ Updating all users...');
  try {
    await adminApi('/api/admin/users/bulk-balance', { amount });
    document.getElementById('bulkBalanceAmount').value = '';
    loadAdminData();
    showToast('✅ All users updated!');
  } catch(e) {
    console.error('Bulk add error:', e);
    showToast('❌ Error during bulk update');
  } finally {
    bulkAddSubmitting = false;
  }
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('admin-' + tab).classList.add('active');
  btn.classList.add('active');
}

function toggleAddChannelForm() {
  const form = document.getElementById('addChannelForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  if (form.style.display === 'none') {
    document.getElementById('channelNameInput').value = '';
    document.getElementById('channelRewardInput').value = '';
  }
}

async function submitAddChannel() {
  let name = document.getElementById('channelNameInput').value.trim();
  const reward = parseInt(document.getElementById('channelRewardInput').value) || 0;

  if (!name || reward <= 0) {
    showToast('❌ Enter username and reward!');
    return;
  }
  if (!name.startsWith('@')) name = '@' + name;

  try {
    await adminApi('/api/admin/channels', { name, description: 'Join our Telegram channel', reward, type: 'social', icon: '📢' });
    await loadChannels();
    toggleAddChannelForm();
    loadAdminData();
    showToast('✅ Task added!');
  } catch(e) {
    console.error('Add channel error:', e);
    showToast('❌ Error adding task');
  }
}

async function deleteChannel(id) {
  if (!confirm('Delete this channel?')) return;
  try {
    const res = await fetch(`${BACKEND_URL}/api/admin/channels/${id}`, {
      method: 'DELETE',
      headers: { 'X-Telegram-Init-Data': window.Telegram?.WebApp?.initData || '' },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'failed');
    allChannels = allChannels.filter(c => c.id !== id);
    renderDynamicTasks();
    loadAdminData();
    showToast('✅ Deleted!');
  } catch(e) {
    console.error('Delete error:', e);
    showToast('❌ Error deleting');
  }
}

async function approveWithdrawal(id) {
  try {
    await adminApi(`/api/admin/withdrawals/${id}/approve`);
    loadAdminData();
    showToast('✅ Approved!');
  } catch(e) {
    console.error('Approve error:', e);
    showToast('❌ Error approving');
  }
}

async function rejectWithdrawal(id) {
  try {
    await adminApi(`/api/admin/withdrawals/${id}/reject`);
    loadAdminData();
    showToast('❌ Rejected!');
  } catch(e) {
    console.error('Reject error:', e);
    showToast('❌ Error rejecting');
  }
}
