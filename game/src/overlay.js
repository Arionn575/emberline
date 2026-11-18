// The DOM HUD: crosshair, scope, hit marker, health, ammo, money, timer,
// team scores, kill feed, bomb status, round banner, plant progress and
// the buy menu, plus the one overlay panel. It never touches the
// simulation; boot.js pushes numbers in and reads the play callback out.
import { GUNS, GRENADE_COST, ARMOR_COST } from './arsenal.js';

const PANELS = {
  start: {
    title: 'Emberline',
    copy: 'A tactical round-based shooter in a desert yard. Plant the bomb at Site A or B — or eliminate the VEX squad. Earn money each round and spend it between rounds. First to 8 rounds takes the match.',
    action: 'Click to play',
  },
  paused: {
    title: 'Emberline',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  matchWin: {
    title: 'Match won',
    copy: 'Ember takes the yard.',
    action: 'Play again',
  },
  matchLose: {
    title: 'Match lost',
    copy: 'VEX holds the yard.',
    action: 'Play again',
  },
};

const SHOP = [
  { key: '1', id: 'rifle' },
  { key: '2', id: 'smg' },
  { key: '3', id: 'sniper' },
  { key: '4', id: 'pistol' },
  { key: 'G', id: 'grenade' },
  { key: 'V', id: 'armor' },
];

export function makeOverlay() {
  const $ = (id) => document.getElementById(id);
  const els = {
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
    play: $('play'),
    ammo: $('ammo'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    money: $('money'),
    weaponName: $('weapon-name'),
    healthNum: $('health-num'),
    healthFill: $('health-fill'),
    armor: $('armor'),
    timer: $('timer'),
    scoreAtk: $('score-atk-num'),
    scoreDef: $('score-def-num'),
    bombStatus: $('bomb-status'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    progress: $('progress'),
    progressLabel: $('progress-label'),
    progressFill: $('progress-fill'),
    killfeed: $('killfeed'),
    hitmarker: $('hitmarker'),
    scope: $('scope'),
    buyPanel: $('buy'),
    buyMoney: $('buy-money'),
    buyRows: $('buy-rows'),
  };
  let hitTimer = 0;
  let bannerTimer = 0;
  const last = { mag: -1, reserve: -1, money: -1, health: -1, armor: -1, timer: '', score: '', bomb: '' };

  function renderShop(money, owned) {
    els.buyRows.innerHTML = '';
    for (const row of SHOP) {
      const div = document.createElement('div');
      div.className = 'buy-row';
      let label;
      let price;
      let ownedNow = false;
      if (row.id === 'grenade') {
        label = 'HE Grenade';
        price = GRENADE_COST;
        ownedNow = owned.grenades > 0;
      } else if (row.id === 'armor') {
        label = 'Kevlar Armor';
        price = ARMOR_COST;
        ownedNow = owned.armor > 0;
      } else {
        label = GUNS[row.id].label;
        price = GUNS[row.id].price;
        ownedNow = owned.weapons.includes(row.id);
      }
      if (ownedNow) div.classList.add('owned');
      const name = document.createElement('span');
      name.innerHTML = `<span class="key">${row.key}</span>${label}`;
      const priceEl = document.createElement('span');
      priceEl.className = 'price' + (ownedNow ? ' owned' : '');
      priceEl.textContent = ownedNow ? 'OWNED' : `$${price}`;
      div.append(name, priceEl);
      els.buyRows.appendChild(div);
    }
    els.buyMoney.textContent = `$${money}`;
  }

  return {
    setAmmo(mag, reserve) {
      if (mag === last.mag && reserve === last.reserve) return;
      last.mag = mag;
      last.reserve = reserve;
      els.ammoMag.textContent = String(mag);
      els.ammoReserve.textContent = `/ ${reserve}`;
      els.ammo.classList.toggle('empty', mag === 0);
    },
    setWeaponName(label) {
      els.weaponName.textContent = label;
    },
    setMoney(value) {
      if (value === last.money) return;
      last.money = value;
      els.money.textContent = `$${value}`;
    },
    setHealth(hp, armor) {
      if (hp === last.health && armor === last.armor) return;
      last.health = hp;
      last.armor = armor;
      els.healthNum.textContent = String(Math.max(0, Math.ceil(hp)));
      els.healthFill.style.width = `${Math.max(0, Math.min(100, hp))}%`;
      els.healthFill.classList.toggle('low', hp <= 30);
      els.armor.textContent = armor > 0 ? `+${armor} armor` : '';
    },
    setTimer(seconds) {
      const s = Math.max(0, Math.ceil(seconds));
      const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (text === last.timer) return;
      last.timer = text;
      els.timer.textContent = text;
      els.timer.classList.toggle('low', s <= 15);
    },
    setScore(atk, def) {
      const text = `${atk}-${def}`;
      if (text === last.score) return;
      last.score = text;
      els.scoreAtk.textContent = String(atk);
      els.scoreDef.textContent = String(def);
    },
    setBombStatus(text, planted) {
      if (text === last.bomb) return;
      last.bomb = text;
      els.bombStatus.textContent = text;
      els.bombStatus.classList.toggle('planted', !!planted);
    },
    showBanner(titleText, subText) {
      els.bannerTitle.textContent = titleText;
      els.bannerSub.textContent = subText;
      els.banner.classList.add('on');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => els.banner.classList.remove('on'), 3500);
    },
    hideBanner() {
      els.banner.classList.remove('on');
      clearTimeout(bannerTimer);
    },
    showProgress(label, frac) {
      els.progress.hidden = false;
      els.progressLabel.textContent = label;
      els.progressFill.style.width = `${Math.round(frac * 100)}%`;
    },
    hideProgress() {
      els.progress.hidden = true;
    },
    addKill(killer, victim, killerTeam) {
      const div = document.createElement('div');
      const killerSpan = document.createElement('span');
      killerSpan.className = killerTeam === 'atk' ? 'atk' : 'def';
      killerSpan.textContent = killer;
      const victimSpan = document.createElement('span');
      victimSpan.className = killerTeam === 'atk' ? 'def' : 'atk';
      victimSpan.textContent = victim;
      div.append(killerSpan, document.createTextNode(' ✕ '), victimSpan);
      els.killfeed.prepend(div);
      while (els.killfeed.children.length > 4) els.killfeed.removeChild(els.killfeed.lastChild);
      setTimeout(() => div.remove(), 6000);
    },
    hitMarker(killed, holdMs = 90) {
      els.hitmarker.classList.add('on');
      els.hitmarker.style.transform = killed ? 'translate(-50%, -50%) rotate(45deg) scale(1.25)' : '';
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        els.hitmarker.classList.remove('on');
        els.hitmarker.style.transform = '';
      }, holdMs);
    },
    setScope(on) {
      els.scope.hidden = !on;
    },
    showBuy(money, owned) {
      renderShop(money, owned);
      els.buyPanel.hidden = false;
    },
    hideBuy() {
      els.buyPanel.hidden = true;
    },
    showPanel(mode, scoreText) {
      const text = PANELS[mode];
      els.overlayTitle.textContent = text.title;
      els.overlayCopy.textContent = scoreText ? `${text.copy} Final score ${scoreText}.` : text.copy;
      els.play.textContent = text.action;
      els.overlay.hidden = false;
      els.play.focus();
    },
    hidePanel() {
      els.overlay.hidden = true;
    },
    onPlay(handler) {
      els.play.addEventListener('click', handler);
    },
  };
}
