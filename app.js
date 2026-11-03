/**
 * app.js — Haupt-Controller & UI für IRON Gym-Tracker
 *
 * Features:
 * 1. Home-Screen mit großen Routine-Kacheln & prominentem "Training fortsetzen"-Banner
 * 2. Aktiver Workout-Screen mit:
 *    - Editierbarer Pausenzeit (⏱ 120s) direkt im Übungs-Header
 *    - "Letztes Mal"-Badge (Format: Letztes Mal: 80kg × 8 | 80kg × 8 | 77.5kg × 7)
 *    - "All-Time PR"-Badge nach echtem Höchstgewicht max(weight), dann max(reps) (Format: PR: 82.5kg × 6)
 *    - Smart Pre-Fill aller Sätze aus dem letzten Workout
 *    - Ein-Tipp-Abhaken [ ✓ ] -> speichert sofort in IndexedDB, färbt Zeile grün, startet Timer
 * 3. Hintergrundsicherer Pausen-Timer über endTime = Date.now() + restSeconds * 1000 in localStorage + visibilitychange
 * 4. Verwaltung (Übungen & Routinen zusammenklicken + Reihenfolge ändern)
 * 5. Einstellungen (JSON-Backup exportieren & importieren)
 */

const {
  db,
  formatWeight,
  ensureSeedData,
  getActiveWorkoutOfToday,
  getExerciseStats,
  createWorkoutFromRoutine,
  exportDatabaseToJson,
  importDatabaseFromJson
} = window.GymDB;

const TIMER_STORAGE_KEY = 'iron_gym_rest_timer_v1';

const state = {
  currentTab: 'home', // 'home' | 'workout' | 'manage' | 'settings'
  activeWorkoutId: null,
  manageRoutineDraftIds: [], // Geordnete Übungs-IDs beim Erstellen/Bearbeiten einer Routine
  editingRoutineId: null,
  timerIntervalId: null,
  audioCtx: null
};

// ============================================================================
// HILFSFUNKTIONEN (Formatierung, Toast, Audio & Vibration)
// ============================================================================

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatSecondsMMSS(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDateShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const colors =
    type === 'error'
      ? 'bg-rose-950/95 border-rose-500 text-rose-200'
      : 'bg-zinc-900/95 border-emerald-500/80 text-emerald-300';

  const el = document.createElement('div');
  el.className = `${colors} border px-4 py-2.5 rounded-xl shadow-xl text-xs font-bold tracking-wide transition-all duration-200 pointer-events-auto`;
  el.textContent = message;
  container.innerHTML = '';
  container.appendChild(el);

  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, 2400);
}

/**
 * Erzeugt ein prägnantes Doppel-Beep über die Web Audio API + Vibration,
 * sobald der Pausen-Timer abläuft.
 */
function triggerTimerAlarm() {
  // 1. Vibration auf Android-Smartphones
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate([250, 120, 350]);
    } catch (_) {}
  }

  // 2. Web Audio API Beep
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!state.audioCtx) {
      state.audioCtx = new AudioContextClass();
    }
    const ctx = state.audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const playTone = (freq, startOffset, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startOffset);

      gain.gain.setValueAtTime(0.001, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.28, ctx.currentTime + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startOffset + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + duration);
    };

    playTone(880, 0, 0.16);
    playTone(1174.66, 0.2, 0.28);
  } catch (err) {
    console.warn('Audio-Alarm konnte nicht abgespielt werden:', err);
  }
}

// Entsperrt die Web Audio API beim ersten Nutzer-Touch
function unlockAudioContextOnce() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const unlock = () => {
    try {
      if (!state.audioCtx) state.audioCtx = new AudioContextClass();
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    } catch (_) {}
    document.removeEventListener('touchstart', unlock);
    document.removeEventListener('click', unlock);
  };
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('click', unlock, { passive: true });
}

// ============================================================================
// HINTERGRUNDSICHERER PAUSEN-TIMER (endTime in localStorage + visibilitychange)
// ============================================================================

function getStoredTimer() {
  try {
    const raw = localStorage.getItem(TIMER_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function setStoredTimer(timerData) {
  if (!timerData) {
    localStorage.removeItem(TIMER_STORAGE_KEY);
  } else {
    localStorage.setItem(TIMER_STORAGE_KEY, JSON.stringify(timerData));
  }
}

function startRestTimer(restSeconds, exerciseName = 'Satzpause') {
  const durationSec = Math.max(5, Number(restSeconds) || 90);
  const now = Date.now();
  const endTime = now + durationSec * 1000;

  setStoredTimer({
    endTime,
    totalSeconds: durationSec,
    exerciseName
  });

  syncRestTimerUI();
  ensureTimerLoop();
}

function adjustRestTimer(deltaSeconds) {
  const timer = getStoredTimer();
  if (!timer) return;

  const now = Date.now();
  const newEndTime = Math.max(now + 1000, timer.endTime + deltaSeconds * 1000);
  const remainingSec = Math.round((newEndTime - now) / 1000);
  const newTotal = Math.max(timer.totalSeconds, remainingSec);

  setStoredTimer({
    ...timer,
    endTime: newEndTime,
    totalSeconds: newTotal
  });

  syncRestTimerUI();
}

function stopRestTimer() {
  setStoredTimer(null);
  if (state.timerIntervalId) {
    clearInterval(state.timerIntervalId);
    state.timerIntervalId = null;
  }
  const bar = document.getElementById('rest-timer-bar');
  if (bar) bar.classList.add('hidden');
}

function syncRestTimerUI() {
  const bar = document.getElementById('rest-timer-bar');
  const countdownEl = document.getElementById('timer-countdown');
  const labelEl = document.getElementById('timer-exercise-label');
  const progressEl = document.getElementById('timer-progress-bar');

  const timer = getStoredTimer();
  if (!timer) {
    if (bar) bar.classList.add('hidden');
    return;
  }

  const remainingSeconds = Math.round((timer.endTime - Date.now()) / 1000);

  if (remainingSeconds <= 0) {
    stopRestTimer();
    triggerTimerAlarm();
    showToast('⏱ Pause abgelaufen — Nächster Satz!');
    return;
  }

  if (bar) bar.classList.remove('hidden');
  if (labelEl) labelEl.textContent = `⏱ PAUSE • ${timer.exerciseName}`;
  if (countdownEl) countdownEl.textContent = formatSecondsMMSS(remainingSeconds);

  if (progressEl) {
    const pct = Math.min(100, Math.max(0, (remainingSeconds / timer.totalSeconds) * 100));
    progressEl.style.width = `${pct}%`;
  }
}

function ensureTimerLoop() {
  if (state.timerIntervalId) clearInterval(state.timerIntervalId);
  state.timerIntervalId = setInterval(() => {
    syncRestTimerUI();
  }, 250);
}

// Kritisch für gesperrtes Smartphone-Display: Sofortige Neuberechnung beim Aufwecken!
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncRestTimerUI();
  }
});

window.addEventListener('focus', () => {
  syncRestTimerUI();
});

// ============================================================================
// NAVIGATION & HEADER
// ============================================================================

function updateNavHighlight() {
  const activeKey = state.currentTab === 'workout' ? 'home' : state.currentTab;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    const isActive = btn.dataset.nav === activeKey;
    btn.className = `nav-tab flex flex-col items-center justify-center gap-1 text-xs font-bold transition-colors ${
      isActive ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
    }`;
  });
}

async function navigateTo(tab, workoutId = null) {
  state.currentTab = tab;
  if (workoutId !== null) {
    state.activeWorkoutId = Number(workoutId);
  }
  updateNavHighlight();
  await renderCurrentView();
}

async function renderCurrentView() {
  const main = document.getElementById('app-main');
  const headerActions = document.getElementById('header-actions');
  const subtitle = document.getElementById('header-subtitle');

  if (!main) return;
  headerActions.innerHTML = '';

  if (state.currentTab === 'home') {
    subtitle.textContent = 'Wähle dein heutiges Training';
    await renderHomeScreen(main);
  } else if (state.currentTab === 'workout') {
    await renderWorkoutScreen(main, headerActions, subtitle);
  } else if (state.currentTab === 'manage') {
    subtitle.textContent = 'Übungen & Routinen verwalten';
    await renderManageScreen(main);
  } else if (state.currentTab === 'settings') {
    subtitle.textContent = 'Lokales Datenbank-Backup (JSON)';
    await renderSettingsScreen(main);
  }
}

// ============================================================================
// 1. HOME-SCREEN (Routinen starten / Aktives Workout fortsetzen)
// ============================================================================

async function renderHomeScreen(container) {
  const [routines, exercises, activeWorkout, allWorkouts] = await Promise.all([
    db.routines.toArray(),
    db.exercises.toArray(),
    getActiveWorkoutOfToday(),
    db.workouts.toArray()
  ]);

  const exerciseMap = new Map(exercises.map((e) => [e.id, e]));
  const completedWorkouts = allWorkouts
    .filter((w) => w.completed)
    .sort((a, b) => b.date - a.date);

  let activeBannerHtml = '';
  if (activeWorkout) {
    const activeRoutine = routines.find((r) => r.id === activeWorkout.routineId);
    const activeSets = await db.sets.where('workoutId').equals(activeWorkout.id).toArray();
    const doneCount = activeSets.filter((s) => s.completed).length;

    activeBannerHtml = `
      <div class="mb-5 rounded-2xl bg-emerald-500/15 border-2 border-emerald-500 p-4 shadow-lg">
        <div class="flex items-center justify-between gap-3">
          <div>
            <span class="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-emerald-400">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
              Aktives Workout heute
            </span>
            <h2 class="text-xl font-black text-white mt-0.5">
              ${escapeHtml(activeRoutine ? activeRoutine.name : 'Training')}
            </h2>
            <p class="text-xs text-zinc-300 mt-0.5">
              Gestartet: ${formatDateShort(activeWorkout.date)} • ${doneCount}/${activeSets.length} Sätze erledigt
            </p>
          </div>
        </div>
        <div class="mt-3.5 flex gap-2">
          <button type="button" data-action="resume-workout" data-workout-id="${activeWorkout.id}"
            class="flex-1 h-14 rounded-xl bg-emerald-500 active:bg-emerald-400 text-zinc-950 font-black text-base tracking-tight shadow-md flex items-center justify-center gap-2">
            <span>▶ Training fortsetzen</span>
          </button>
          <button type="button" data-action="discard-workout" data-workout-id="${activeWorkout.id}"
            class="h-14 px-4 rounded-xl bg-zinc-900/90 active:bg-zinc-800 border border-zinc-700 text-zinc-400 font-bold text-xs">
            Verwerfen
          </button>
        </div>
      </div>
    `;
  }

  const routineCardsHtml = routines
    .map((routine) => {
      const exNames = (routine.exerciseIds || [])
        .map((id) => exerciseMap.get(Number(id))?.name)
        .filter(Boolean);

      const lastDone = completedWorkouts.find((w) => w.routineId === routine.id);
      const lastDoneText = lastDone
        ? `Zuletzt: ${formatDateShort(lastDone.date)}`
        : 'Noch nicht absolviert';

      return `
        <button type="button" data-action="start-routine" data-routine-id="${routine.id}"
          class="w-full text-left rounded-2xl bg-zinc-900 active:bg-zinc-800/90 border border-zinc-800 hover:border-zinc-700 p-4 transition-all shadow-md flex flex-col justify-between gap-3">
          <div class="flex items-start justify-between gap-3 w-full">
            <div>
              <h3 class="text-lg font-black text-zinc-100 leading-snug">
                ${escapeHtml(routine.name)}
              </h3>
              <p class="text-xs font-semibold text-emerald-400 mt-0.5">
                ${exNames.length} Übungen • ${lastDoneText}
              </p>
            </div>
            <span class="shrink-0 h-11 px-4 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-extrabold text-xs flex items-center">
              Starten →
            </span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${
              exNames.length > 0
                ? exNames
                    .map(
                      (name) =>
                        `<span class="text-[11px] font-medium bg-zinc-950 border border-zinc-800 text-zinc-300 px-2.5 py-1 rounded-lg">${escapeHtml(name)}</span>`
                    )
                    .join('')
                : `<span class="text-xs text-zinc-500 italic">Keine Übungen zugewiesen</span>`
            }
          </div>
        </button>
      `;
    })
    .join('');

  container.innerHTML = `
    ${activeBannerHtml}

    <div class="flex items-center justify-between mb-3">
      <h2 class="text-xs font-extrabold uppercase tracking-wider text-zinc-400">
        Deine Routinen (Antippen zum Starten)
      </h2>
      <button type="button" data-action="go-manage" class="text-xs font-bold text-emerald-400 py-1 px-2">
        + Anpassen
      </button>
    </div>

    <div class="space-y-3">
      ${
        routineCardsHtml ||
        `<div class="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 text-center text-zinc-400 text-sm">
          Noch keine Routine vorhanden. Lege unter "Übungen & Pläne" eine Routine an.
        </div>`
      }
    </div>
  `;
}

// ============================================================================
// 2. AKTIVER WORKOUT-SCREEN (Übungskarten, Badges, Smart Pre-Fill)
// ============================================================================

async function renderWorkoutScreen(container, headerActions, subtitle) {
  if (!state.activeWorkoutId) {
    const activeToday = await getActiveWorkoutOfToday();
    if (activeToday) {
      state.activeWorkoutId = activeToday.id;
    } else {
      return navigateTo('home');
    }
  }

  const workout = await db.workouts.get(Number(state.activeWorkoutId));
  if (!workout) {
    state.activeWorkoutId = null;
    return navigateTo('home');
  }

  const routine = await db.routines.get(Number(workout.routineId));
  const workoutSets = await db.sets.where('workoutId').equals(workout.id).toArray();

  // Bestimme die geordnete Liste an Übungen dieser Einheit
  const exerciseOrderIds = routine
    ? routine.exerciseIds.map(Number)
    : [...new Set(workoutSets.map((s) => Number(s.exerciseId)))];

  const exercisesList = await db.exercises.bulkGet(exerciseOrderIds);
  const validExercises = exercisesList.filter(Boolean);

  subtitle.textContent = routine ? routine.name : 'Aktives Training';

  headerActions.innerHTML = `
    <button type="button" data-action="finish-workout" data-workout-id="${workout.id}"
      class="h-10 px-3.5 rounded-xl bg-emerald-500 active:bg-emerald-400 text-zinc-950 font-black text-xs tracking-tight shadow">
      ✓ Beenden
    </button>
  `;

  // Baue alle Übungskarten inkl. "Letztes Mal" und "All-Time PR"
  const cardsHtmlParts = [];

  for (const exercise of validExercises) {
    const stats = await getExerciseStats(exercise.id, workout.id);
    const exSets = workoutSets
      .filter((s) => Number(s.exerciseId) === exercise.id)
      .sort((a, b) => a.setNumber - b.setNumber);

    cardsHtmlParts.push(renderExerciseCardHtml(exercise, exSets, stats));
  }

  container.innerHTML = `
    <div class="space-y-4">
      ${cardsHtmlParts.join('')}
    </div>

    <div class="mt-6 pt-2">
      <button type="button" data-action="finish-workout" data-workout-id="${workout.id}"
        class="w-full h-14 rounded-2xl bg-emerald-500 active:bg-emerald-400 text-zinc-950 font-black text-base tracking-tight shadow-lg flex items-center justify-center gap-2">
        <span>✓ Training abschließen &amp; speichern</span>
      </button>
    </div>
  `;
}

function buildBadgesHtml(stats) {
  const { lastSets, prSet } = stats;

  const lastFormatted =
    lastSets && lastSets.length > 0
      ? lastSets.map((s) => `${formatWeight(s.weight)}kg × ${s.reps}`).join(' | ')
      : 'Keine Daten';

  const prFormatted = prSet
    ? `${formatWeight(prSet.weight)}kg × ${prSet.reps}`
    : '—';

  return `
    <div class="mt-2.5 flex flex-wrap items-center gap-1.5">
      <div class="inline-flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-[11px] text-zinc-300 font-semibold">
        <span class="text-zinc-500 font-bold">Letztes Mal:</span>
        <span class="text-zinc-100 font-mono">${escapeHtml(lastFormatted)}</span>
      </div>
      <div class="inline-flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1 text-[11px] text-amber-300 font-extrabold"
           data-pr-badge="true">
        <span>🏆 PR:</span>
        <span class="font-mono" data-pr-text="true">${escapeHtml(prFormatted)}</span>
      </div>
    </div>
  `;
}

function renderSetRowHtml(setObj, exercise, refSet) {
  const isDone = Boolean(setObj.completed);
  const weightVal =
    setObj.weight !== '' && setObj.weight !== null && setObj.weight !== undefined
      ? formatWeight(setObj.weight)
      : '';
  const repsVal =
    setObj.reps !== '' && setObj.reps !== null && setObj.reps !== undefined
      ? String(setObj.reps)
      : '';

  const weightPlaceholder = refSet ? formatWeight(refSet.weight) : '0';
  const repsPlaceholder = refSet ? String(refSet.reps) : '8';

  const rowBg = isDone
    ? 'bg-emerald-950/40 border-emerald-500/50'
    : 'bg-zinc-950/70 border-zinc-800/90';

  const checkBtnStyle = isDone
    ? 'bg-emerald-500 text-zinc-950 border-emerald-400 shadow-md shadow-emerald-500/20'
    : 'bg-zinc-800/90 text-zinc-400 border-zinc-700 active:bg-zinc-700';

  return `
    <div class="set-row grid grid-cols-12 items-center gap-1.5 p-1.5 rounded-xl border transition-colors ${rowBg}"
         data-set-id="${setObj.id}"
         data-exercise-id="${exercise.id}">
      <!-- Satz-Nummer -->
      <div class="col-span-2 flex items-center justify-center">
        <span class="set-number-badge w-8 h-10 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-xs font-black ${
          isDone ? 'text-emerald-400 border-emerald-500/40' : 'text-zinc-400'
        }">
          #${setObj.setNumber}
        </span>
      </div>

      <!-- Gewicht (kg) -->
      <div class="col-span-4">
        <input
          type="number"
          step="any"
          inputmode="decimal"
          aria-label="Gewicht in kg für Satz ${setObj.setNumber}"
          placeholder="${escapeHtml(weightPlaceholder)}"
          value="${escapeHtml(weightVal)}"
          data-input-field="weight"
          data-set-id="${setObj.id}"
          class="w-full h-12 rounded-xl bg-zinc-900 border border-zinc-700/80 focus:border-emerald-500 focus:outline-none text-center text-lg font-black font-mono text-white placeholder-zinc-600"
        />
      </div>

      <!-- Wiederholungen (Wdh) -->
      <div class="col-span-3">
        <input
          type="number"
          step="1"
          inputmode="numeric"
          aria-label="Wiederholungen für Satz ${setObj.setNumber}"
          placeholder="${escapeHtml(repsPlaceholder)}"
          value="${escapeHtml(repsVal)}"
          data-input-field="reps"
          data-set-id="${setObj.id}"
          class="w-full h-12 rounded-xl bg-zinc-900 border border-zinc-700/80 focus:border-emerald-500 focus:outline-none text-center text-lg font-black font-mono text-white placeholder-zinc-600"
        />
      </div>

      <!-- Haken [ ✓ ] (Großes Touch-Target) -->
      <div class="col-span-2">
        <button
          type="button"
          data-action="toggle-set"
          data-set-id="${setObj.id}"
          data-exercise-id="${exercise.id}"
          aria-label="Satz ${setObj.setNumber} abhaken"
          class="w-full h-12 rounded-xl border font-black text-lg flex items-center justify-center transition-all ${checkBtnStyle}">
          ✓
        </button>
      </div>

      <!-- Satz löschen -->
      <div class="col-span-1 flex items-center justify-center">
        <button
          type="button"
          data-action="delete-set"
          data-set-id="${setObj.id}"
          data-exercise-id="${exercise.id}"
          title="Satz löschen"
          aria-label="Satz ${setObj.setNumber} löschen"
          class="w-8 h-12 rounded-lg text-zinc-500 active:text-rose-400 flex items-center justify-center text-base font-bold">
          ✕
        </button>
      </div>
    </div>
  `;
}

function renderExerciseCardHtml(exercise, exSets, stats) {
  const { lastSets } = stats;

  const rowsHtml = exSets
    .map((s, idx) => {
      const refSet = lastSets[idx] || lastSets[lastSets.length - 1] || null;
      return renderSetRowHtml(s, exercise, refSet);
    })
    .join('');

  return `
    <section class="exercise-card rounded-2xl bg-zinc-900 border border-zinc-800 p-3.5 shadow-md"
             data-exercise-card="${exercise.id}">
      <!-- Übungs-Header -->
      <div class="flex items-start justify-between gap-2">
        <h3 class="text-base font-black text-zinc-100 leading-snug">
          ${escapeHtml(exercise.name)}
        </h3>
        <button
          type="button"
          data-action="edit-rest-time"
          data-exercise-id="${exercise.id}"
          class="shrink-0 h-9 px-3 rounded-xl bg-zinc-950 active:bg-zinc-800 border border-zinc-700 text-emerald-400 font-extrabold text-xs flex items-center gap-1">
          <span>⏱</span>
          <span data-rest-label="${exercise.id}">${exercise.defaultRestSeconds}s</span>
        </button>
      </div>

      <!-- Statistik-Badges: Letztes Mal & All-Time PR -->
      <div data-badges-container="${exercise.id}">
        ${buildBadgesHtml(stats)}
      </div>

      <!-- Spaltenköpfe -->
      <div class="grid grid-cols-12 gap-1.5 px-1.5 mt-3 mb-1 text-[10px] font-extrabold uppercase tracking-wider text-zinc-500 text-center">
        <div class="col-span-2">Satz</div>
        <div class="col-span-4">kg</div>
        <div class="col-span-3">Wdh</div>
        <div class="col-span-2">Done</div>
        <div class="col-span-1"></div>
      </div>

      <!-- Satz-Zeilen -->
      <div class="space-y-1.5" data-sets-list="${exercise.id}">
        ${rowsHtml}
      </div>

      <!-- + Satz hinzufügen -->
      <button
        type="button"
        data-action="add-set"
        data-exercise-id="${exercise.id}"
        class="mt-2.5 w-full h-11 rounded-xl bg-zinc-950 active:bg-zinc-800 border border-dashed border-zinc-700 text-zinc-300 font-bold text-xs flex items-center justify-center gap-1.5">
        <span>+ Satz hinzufügen</span>
      </button>
    </section>
  `;
}

/**
 * Aktualisiert die PR- & Letztes-Mal-Badges einer einzelnen Übungskarte ohne Seiten-Reload.
 */
async function refreshExerciseBadgesInDOM(exerciseId) {
  const container = document.querySelector(`[data-badges-container="${exerciseId}"]`);
  if (!container) return;
  const stats = await getExerciseStats(Number(exerciseId), state.activeWorkoutId);
  container.innerHTML = buildBadgesHtml(stats);
}

// ============================================================================
// 3. VERWALTUNG (Übungen & Routinen zusammenklicken)
// ============================================================================

async function renderManageScreen(container) {
  const [exercises, routines] = await Promise.all([
    db.exercises.toArray(),
    db.routines.toArray()
  ]);

  const exerciseMap = new Map(exercises.map((e) => [e.id, e]));

  // Falls noch kein Draft geladen ist, initialisiere leer
  state.manageRoutineDraftIds = state.manageRoutineDraftIds.filter((id) =>
    exerciseMap.has(Number(id))
  );

  const selectedListHtml =
    state.manageRoutineDraftIds.length > 0
      ? state.manageRoutineDraftIds
          .map((id, idx) => {
            const ex = exerciseMap.get(Number(id));
            if (!ex) return '';
            return `
              <div class="flex items-center justify-between gap-2 bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-6 h-6 rounded-md bg-emerald-500/20 text-emerald-400 font-black text-xs flex items-center justify-center shrink-0">
                    ${idx + 1}
                  </span>
                  <span class="text-sm font-bold text-zinc-100 truncate">${escapeHtml(ex.name)}</span>
                  <span class="text-[11px] text-zinc-500 font-mono shrink-0">(${ex.defaultRestSeconds}s)</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button type="button" data-action="draft-move-up" data-index="${idx}"
                    class="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 font-bold text-xs">↑</button>
                  <button type="button" data-action="draft-move-down" data-index="${idx}"
                    class="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 font-bold text-xs">↓</button>
                  <button type="button" data-action="draft-remove" data-index="${idx}"
                    class="w-9 h-9 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 font-bold text-xs">✕</button>
                </div>
              </div>
            `;
          })
          .join('')
      : `<p class="text-xs text-zinc-500 italic py-2">Tippe unten auf Übungen, um sie in deiner gewünschten Reihenfolge hinzuzufügen.</p>`;

  const availableChipsHtml = exercises
    .map((ex) => {
      const inDraft = state.manageRoutineDraftIds.includes(ex.id);
      return `
        <button type="button" data-action="draft-add-exercise" data-exercise-id="${ex.id}"
          class="h-10 px-3 rounded-xl border text-xs font-bold flex items-center gap-1.5 transition-all ${
            inDraft
              ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
              : 'bg-zinc-950 border-zinc-800 text-zinc-200 active:bg-zinc-800'
          }">
          <span>+ ${escapeHtml(ex.name)}</span>
          <span class="text-[10px] text-zinc-500">${ex.defaultRestSeconds}s</span>
        </button>
      `;
    })
    .join('');

  const editingRoutine = state.editingRoutineId
    ? routines.find((r) => r.id === state.editingRoutineId)
    : null;

  const existingRoutinesHtml = routines
    .map((r) => {
      const names = (r.exerciseIds || [])
        .map((id) => exerciseMap.get(Number(id))?.name)
        .filter(Boolean)
        .join(' → ');

      return `
        <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3 flex items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-extrabold text-sm text-zinc-100">${escapeHtml(r.name)}</div>
            <div class="text-xs text-zinc-400 truncate mt-0.5">${escapeHtml(names || 'Keine Übungen')}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" data-action="edit-routine" data-routine-id="${r.id}"
              class="h-10 px-3 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-bold">
              Edit
            </button>
            <button type="button" data-action="delete-routine" data-routine-id="${r.id}"
              class="h-10 px-3 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-bold">
              ✕
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  const exercisesListHtml = exercises
    .map(
      (ex) => `
      <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="font-bold text-sm text-zinc-100 truncate">${escapeHtml(ex.name)}</div>
          <div class="text-xs text-zinc-400 mt-0.5">
            Standard: <span class="text-emerald-400 font-semibold">${ex.targetSets} Sätze</span> •
            Pause: <span class="text-emerald-400 font-semibold">${ex.defaultRestSeconds}s</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" data-action="edit-rest-time" data-exercise-id="${ex.id}"
            class="h-10 px-3 rounded-lg bg-zinc-900 border border-zinc-700 text-emerald-400 text-xs font-bold">
            ⏱ ${ex.defaultRestSeconds}s
          </button>
          <button type="button" data-action="delete-exercise" data-exercise-id="${ex.id}"
            class="h-10 px-3 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-bold">
            ✕
          </button>
        </div>
      </div>
    `
    )
    .join('');

  container.innerHTML = `
    <div class="space-y-6">
      <!-- BEREICH A: Neue Übung anlegen -->
      <section class="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 shadow-md">
        <h2 class="text-sm font-black uppercase tracking-wider text-emerald-400 mb-3">
          1. Neue Übung anlegen
        </h2>
        <form id="form-new-exercise" class="space-y-3">
          <div>
            <label class="block text-xs font-bold text-zinc-400 mb-1">Übungsname</label>
            <input type="text" name="name" required placeholder="z. B. Schrägbankdrücken KH"
              class="w-full h-12 rounded-xl bg-zinc-950 border border-zinc-700 px-3.5 text-sm font-bold text-white placeholder-zinc-600 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div class="grid grid-cols-2 gap-2.5">
            <div>
              <label class="block text-xs font-bold text-zinc-400 mb-1">Pausenzeit (Sek.)</label>
              <input type="number" name="defaultRestSeconds" value="120" min="15" step="5" required
                class="w-full h-12 rounded-xl bg-zinc-950 border border-zinc-700 px-3.5 text-sm font-black font-mono text-white focus:border-emerald-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-bold text-zinc-400 mb-1">Ziel-Sätze</label>
              <input type="number" name="targetSets" value="3" min="1" max="15" required
                class="w-full h-12 rounded-xl bg-zinc-950 border border-zinc-700 px-3.5 text-sm font-black font-mono text-white focus:border-emerald-500 focus:outline-none" />
            </div>
          </div>
          <button type="submit"
            class="w-full h-12 rounded-xl bg-emerald-500 active:bg-emerald-400 text-zinc-950 font-black text-sm shadow">
            + Übung speichern
          </button>
        </form>
      </section>

      <!-- BEREICH B: Routine zusammenklicken -->
      <section class="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 shadow-md">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-black uppercase tracking-wider text-emerald-400">
            2. ${editingRoutine ? `Routine bearbeiten: ${escapeHtml(editingRoutine.name)}` : 'Routine zusammenklicken'}
          </h2>
          ${
            editingRoutine
              ? `<button type="button" data-action="cancel-edit-routine" class="text-xs font-bold text-zinc-400 underline">Abbrechen</button>`
              : ''
          }
        </div>

        <form id="form-save-routine" class="space-y-3">
          <div>
            <label class="block text-xs font-bold text-zinc-400 mb-1">Name der Routine</label>
            <input type="text" id="routine-name-input" name="routineName" required
              placeholder="z. B. Push A / Oberkörper"
              value="${escapeHtml(editingRoutine ? editingRoutine.name : '')}"
              class="w-full h-12 rounded-xl bg-zinc-950 border border-zinc-700 px-3.5 text-sm font-bold text-white placeholder-zinc-600 focus:border-emerald-500 focus:outline-none" />
          </div>

          <div>
            <label class="block text-xs font-bold text-zinc-400 mb-1.5">
              Gewählte Reihenfolge (${state.manageRoutineDraftIds.length} Übungen)
            </label>
            <div class="space-y-1.5">
              ${selectedListHtml}
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-zinc-400 mb-1.5">
              Übung per Tipp zur Routine hinzufügen:
            </label>
            <div class="flex flex-wrap gap-1.5">
              ${availableChipsHtml}
            </div>
          </div>

          <button type="submit"
            class="w-full h-12 rounded-xl bg-emerald-500 active:bg-emerald-400 text-zinc-950 font-black text-sm shadow">
            ${editingRoutine ? '✓ Änderungen an Routine speichern' : '+ Neue Routine speichern'}
          </button>
        </form>

        <!-- Bestehende Routinen -->
        <div class="mt-5 pt-4 border-t border-zinc-800 space-y-2">
          <h3 class="text-xs font-extrabold uppercase tracking-wider text-zinc-400">Gespeicherte Routinen</h3>
          ${existingRoutinesHtml}
        </div>
      </section>

      <!-- BEREICH C: Alle Übungen -->
      <section class="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 shadow-md">
        <h2 class="text-sm font-black uppercase tracking-wider text-zinc-300 mb-3">
          Alle Übungen (${exercises.length})
        </h2>
        <div class="space-y-2">
          ${exercisesListHtml}
        </div>
      </section>
    </div>
  `;
}

// ============================================================================
// 4. EINSTELLUNGEN & BACKUP (JSON Export / Import)
// ============================================================================

async function renderSettingsScreen(container) {
  const [exCount, routineCount, workoutCount, setCount] = await Promise.all([
    db.exercises.count(),
    db.routines.count(),
    db.workouts.count(),
    db.sets.count()
  ]);

  container.innerHTML = `
    <div class="space-y-5">
      <!-- Datenbank-Status -->
      <section class="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 shadow-md">
        <h2 class="text-sm font-black uppercase tracking-wider text-emerald-400 mb-3">
          Lokaler Speicherstatus (IndexedDB)
        </h2>
        <div class="grid grid-cols-2 gap-2.5 text-center">
          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-2xl font-black font-mono text-white">${workoutCount}</div>
            <div class="text-xs text-zinc-400 font-bold">Workouts</div>
          </div>
          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-2xl font-black font-mono text-emerald-400">${setCount}</div>
            <div class="text-xs text-zinc-400 font-bold">Geloggte Sätze</div>
          </div>
          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-2xl font-black font-mono text-white">${routineCount}</div>
            <div class="text-xs text-zinc-400 font-bold">Routinen</div>
          </div>
          <div class="rounded-xl bg-zinc-950 border border-zinc-800 p-3">
            <div class="text-2xl font-black font-mono text-white">${exCount}</div>
            <div class="text-xs text-zinc-400 font-bold">Übungen</div>
          </div>
        </div>
      </section>

      <!-- Backup Export / Import -->
      <section class="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 shadow-md space-y-3">
        <h2 class="text-sm font-black uppercase tracking-wider text-emerald-400">
          Datensicherung (JSON Backup)
        </h2>
        <p class="text-xs text-zinc-400 leading-relaxed">
          Alle Trainingsdaten liegen zu 100% offline in deiner Browser-IndexedDB. Sichere deine Daten regelmäßig als <code class="text-zinc-200">.json</code>-Datei auf deinem Smartphone.
        </p>

        <button type="button" data-action="export-backup"
          class="w-full h-14 rounded-xl bg-emerald-500 active:bg-emerald-400 text-zinc-950 font-black text-sm shadow flex items-center justify-center gap-2">
          <span>⬇ Backup exportieren (JSON)</span>
        </button>

        <label class="w-full h-14 rounded-xl bg-zinc-950 active:bg-zinc-800 border-2 border-zinc-700 text-zinc-100 font-black text-sm flex items-center justify-center gap-2 cursor-pointer">
          <span>⬆ Backup importieren (JSON)</span>
          <input type="file" id="input-import-backup" accept="application/json,.json" class="hidden" />
        </label>
      </section>

      <!-- Sound & Timer Test -->
      <section class="rounded-2xl bg-zinc-900 border border-zinc-800 p-4 shadow-md space-y-3">
        <h2 class="text-sm font-black uppercase tracking-wider text-zinc-300">
          Pausen-Timer &amp; Audio-Test
        </h2>
        <div class="flex gap-2">
          <button type="button" data-action="test-timer-sound"
            class="flex-1 h-12 rounded-xl bg-zinc-950 active:bg-zinc-800 border border-zinc-700 text-zinc-200 font-bold text-xs">
            🔊 Beep &amp; Vibration testen
          </button>
          <button type="button" data-action="test-timer-5s"
            class="flex-1 h-12 rounded-xl bg-zinc-950 active:bg-zinc-800 border border-zinc-700 text-emerald-400 font-bold text-xs">
            ⏱ 5s Test-Timer starten
          </button>
        </div>
      </section>
    </div>
  `;
}

// ============================================================================
// MODAL: Pausenzeit einer Übung direkt per Tipp editieren
// ============================================================================

async function openEditRestModal(exerciseId) {
  const exercise = await db.exercises.get(Number(exerciseId));
  if (!exercise) return;

  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  if (!backdrop || !content) return;

  const presets = [60, 90, 120, 150, 180, 240];

  content.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-base font-black text-white truncate">${escapeHtml(exercise.name)}</h3>
      <button type="button" data-action="close-modal" class="w-9 h-9 rounded-lg bg-zinc-800 text-zinc-400 font-bold">✕</button>
    </div>
    <p class="text-xs text-zinc-400 mb-3">Individuelle Pausenzeit in Sekunden:</p>

    <div class="grid grid-cols-3 gap-2 mb-3">
      ${presets
        .map(
          (sec) => `
          <button type="button" data-action="preset-rest" data-seconds="${sec}"
            class="h-11 rounded-xl border font-mono font-bold text-xs ${
              exercise.defaultRestSeconds === sec
                ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                : 'bg-zinc-950 border-zinc-800 text-zinc-300'
            }">
            ${sec}s
          </button>
        `
        )
        .join('')}
    </div>

    <form id="form-update-rest" data-exercise-id="${exercise.id}" class="flex gap-2">
      <input type="number" id="modal-rest-input" value="${exercise.defaultRestSeconds}" min="10" max="900" step="5" required
        class="flex-1 h-12 rounded-xl bg-zinc-950 border border-zinc-700 px-3 text-center font-mono text-lg font-black text-white focus:border-emerald-500 focus:outline-none" />
      <button type="submit"
        class="h-12 px-5 rounded-xl bg-emerald-500 text-zinc-950 font-black text-sm">
        Speichern
      </button>
    </form>
  `;

  backdrop.classList.remove('hidden');
}

function closeModal() {
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.classList.add('hidden');
}

// ============================================================================
// EVENT-DELEGATION FÜR ALLE TOUCH-INTERAKTIONEN
// ============================================================================

function bindEvents() {
  // Bottom-Navigation
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      if (target === 'home' && state.activeWorkoutId) {
        navigateTo('workout', state.activeWorkoutId);
      } else {
        navigateTo(target);
      }
    });
  });

  // Sticky Timer Buttons (-15s, +30s, Skip)
  document.getElementById('btn-timer-minus')?.addEventListener('click', () => adjustRestTimer(-15));
  document.getElementById('btn-timer-plus')?.addEventListener('click', () => adjustRestTimer(30));
  document.getElementById('btn-timer-skip')?.addEventListener('click', () => {
    stopRestTimer();
    showToast('Pause übersprungen');
  });

  // Live-Speicherung bei Eingabe in kg / Wdh Feldern
  document.addEventListener('input', async (e) => {
    const input = e.target.closest('input[data-input-field]');
    if (!input) return;

    const setId = Number(input.dataset.setId);
    const field = input.dataset.inputField; // 'weight' | 'reps'
    const rawVal = input.value.trim().replace(',', '.');

    const updatePayload = {};
    if (field === 'weight') {
      updatePayload.weight = rawVal === '' ? '' : parseFloat(rawVal);
    } else if (field === 'reps') {
      updatePayload.reps = rawVal === '' ? '' : parseInt(rawVal, 10);
    }

    await db.sets.update(setId, updatePayload);

    // Falls der Satz bereits abgehakt ist, aktualisiere sofort den PR-Badge
    const row = input.closest('.set-row');
    if (row) {
      const exerciseId = Number(row.dataset.exerciseId);
      await refreshExerciseBadgesInDOM(exerciseId);
    }
  });

  // Datei-Import für JSON-Backup
  document.addEventListener('change', async (e) => {
    if (e.target && e.target.id === 'input-import-backup') {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        await importDatabaseFromJson(parsed);
        state.activeWorkoutId = null;
        showToast('Backup erfolgreich wiederhergestellt!');
        await renderCurrentView();
      } catch (err) {
        showToast(`Import-Fehler: ${err.message}`, 'error');
      } finally {
        e.target.value = '';
      }
    }
  });

  // Formular-Submits (Übung anlegen, Routine speichern, Pausenzeit speichern)
  document.addEventListener('submit', async (e) => {
    const form = e.target;

    if (form.id === 'form-new-exercise') {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const defaultRestSeconds = Math.max(10, parseInt(fd.get('defaultRestSeconds'), 10) || 120);
      const targetSets = Math.max(1, parseInt(fd.get('targetSets'), 10) || 3);
      if (!name) return;

      const newId = await db.exercises.add({ name, defaultRestSeconds, targetSets });
      state.manageRoutineDraftIds.push(newId);
      form.reset();
      showToast(`Übung "${name}" angelegt`);
      await renderCurrentView();
    }

    if (form.id === 'form-save-routine') {
      e.preventDefault();
      const nameInput = document.getElementById('routine-name-input');
      const name = String(nameInput?.value || '').trim();
      if (!name) return;
      if (state.manageRoutineDraftIds.length === 0) {
        showToast('Bitte mindestens eine Übung zur Routine hinzufügen', 'error');
        return;
      }

      if (state.editingRoutineId) {
        await db.routines.update(state.editingRoutineId, {
          name,
          exerciseIds: [...state.manageRoutineDraftIds]
        });
        showToast(`Routine "${name}" aktualisiert`);
      } else {
        await db.routines.add({
          name,
          exerciseIds: [...state.manageRoutineDraftIds]
        });
        showToast(`Routine "${name}" erstellt`);
      }

      state.editingRoutineId = null;
      state.manageRoutineDraftIds = [];
      await renderCurrentView();
    }

    if (form.id === 'form-update-rest') {
      e.preventDefault();
      const exerciseId = Number(form.dataset.exerciseId);
      const input = document.getElementById('modal-rest-input');
      const newSec = Math.max(10, parseInt(input?.value, 10) || 90);
      await db.exercises.update(exerciseId, { defaultRestSeconds: newSec });

      // Direkt im DOM aktualisieren, falls wir im Workout-Screen sind
      const label = document.querySelector(`[data-rest-label="${exerciseId}"]`);
      if (label) label.textContent = `${newSec}s`;

      closeModal();
      showToast(`Pausenzeit auf ${newSec}s gesetzt`);
      if (state.currentTab === 'manage') {
        await renderCurrentView();
      }
    }
  });

  // Alle Button-Klicks über data-action
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (e.target.id === 'modal-backdrop') closeModal();
      return;
    }

    const action = btn.dataset.action;

    // --- HOME ACTIONS ---
    if (action === 'start-routine') {
      const routineId = Number(btn.dataset.routineId);
      const workoutId = await createWorkoutFromRoutine(routineId);
      await navigateTo('workout', workoutId);
      showToast('Workout gestartet — Viel Erfolg!');
    }

    if (action === 'resume-workout') {
      const workoutId = Number(btn.dataset.workoutId);
      await navigateTo('workout', workoutId);
    }

    if (action === 'discard-workout') {
      const workoutId = Number(btn.dataset.workoutId);
      await db.transaction('rw', db.workouts, db.sets, async () => {
        await db.sets.where('workoutId').equals(workoutId).delete();
        await db.workouts.delete(workoutId);
      });
      if (state.activeWorkoutId === workoutId) state.activeWorkoutId = null;
      stopRestTimer();
      showToast('Workout verworfen');
      await renderCurrentView();
    }

    if (action === 'go-manage') {
      await navigateTo('manage');
    }

    // --- WORKOUT ACTIONS ---
    if (action === 'toggle-set') {
      const setId = Number(btn.dataset.setId);
      const exerciseId = Number(btn.dataset.exerciseId);
      const setObj = await db.sets.get(setId);
      const exercise = await db.exercises.get(exerciseId);
      if (!setObj || !exercise) return;

      const row = btn.closest('.set-row');
      const weightInput = row?.querySelector('input[data-input-field="weight"]');
      const repsInput = row?.querySelector('input[data-input-field="reps"]');

      // Falls Input leer gelassen wurde, übernehme den Smart-Placeholder-Wert!
      let weightVal = weightInput?.value.trim().replace(',', '.');
      if (weightVal === '' || weightVal === undefined) {
        weightVal = weightInput?.getAttribute('placeholder') || '0';
        if (weightInput) weightInput.value = weightVal;
      }

      let repsVal = repsInput?.value.trim();
      if (repsVal === '' || repsVal === undefined) {
        repsVal = repsInput?.getAttribute('placeholder') || '8';
        if (repsInput) repsInput.value = repsVal;
      }

      const finalWeight = parseFloat(weightVal) || 0;
      const finalReps = parseInt(repsVal, 10) || 0;
      const nextCompleted = !setObj.completed;

      await db.sets.update(setId, {
        weight: finalWeight,
        reps: finalReps,
        completed: nextCompleted,
        timestamp: Date.now()
      });

      // Aktualisiere Zeilen-Optik sofort ohne Scroll-Verlust
      if (row) {
        row.className = `set-row grid grid-cols-12 items-center gap-1.5 p-1.5 rounded-xl border transition-colors ${
          nextCompleted
            ? 'bg-emerald-950/40 border-emerald-500/50'
            : 'bg-zinc-950/70 border-zinc-800/90'
        }`;
        const badge = row.querySelector('.set-number-badge');
        if (badge) {
          badge.className = `set-number-badge w-8 h-10 rounded-lg bg-zinc-900 border flex items-center justify-center text-xs font-black ${
            nextCompleted
              ? 'text-emerald-400 border-emerald-500/40'
              : 'text-zinc-400 border-zinc-800'
          }`;
        }
        btn.className = `w-full h-12 rounded-xl border font-black text-lg flex items-center justify-center transition-all ${
          nextCompleted
            ? 'bg-emerald-500 text-zinc-950 border-emerald-400 shadow-md shadow-emerald-500/20'
            : 'bg-zinc-800/90 text-zinc-400 border-zinc-700 active:bg-zinc-700'
        }`;
      }

      // PR-Badge live neu berechnen
      await refreshExerciseBadgesInDOM(exerciseId);

      // Starte automatisch den hintergrundsicheren Pausen-Timer mit defaultRestSeconds dieser Übung
      if (nextCompleted) {
        startRestTimer(exercise.defaultRestSeconds, exercise.name);
      }
    }

    if (action === 'add-set') {
      const exerciseId = Number(btn.dataset.exerciseId);
      const exercise = await db.exercises.get(exerciseId);
      if (!exercise || !state.activeWorkoutId) return;

      const existingSets = await db.sets
        .where('[workoutId+exerciseId]')
        .equals([Number(state.activeWorkoutId), exerciseId])
        .toArray();
      existingSets.sort((a, b) => a.setNumber - b.setNumber);

      const nextSetNum = existingSets.length + 1;
      const stats = await getExerciseStats(exerciseId, state.activeWorkoutId);
      const lastExisting = existingSets[existingSets.length - 1];
      const refFromHistory =
        stats.lastSets[nextSetNum - 1] || stats.lastSets[stats.lastSets.length - 1] || null;

      const prefillWeight =
        lastExisting && lastExisting.weight !== ''
          ? Number(lastExisting.weight)
          : refFromHistory
          ? Number(refFromHistory.weight)
          : '';
      const prefillReps =
        lastExisting && lastExisting.reps !== ''
          ? Number(lastExisting.reps)
          : refFromHistory
          ? Number(refFromHistory.reps)
          : '';

      const newSetObj = {
        workoutId: Number(state.activeWorkoutId),
        exerciseId,
        setNumber: nextSetNum,
        weight: prefillWeight,
        reps: prefillReps,
        completed: false,
        timestamp: Date.now()
      };

      const newId = await db.sets.add(newSetObj);
      newSetObj.id = newId;

      const listEl = document.querySelector(`[data-sets-list="${exerciseId}"]`);
      if (listEl) {
        listEl.insertAdjacentHTML(
          'beforeend',
          renderSetRowHtml(newSetObj, exercise, refFromHistory)
        );
      }
    }

    if (action === 'delete-set') {
      const setId = Number(btn.dataset.setId);
      const exerciseId = Number(btn.dataset.exerciseId);
      await db.sets.delete(setId);

      // Nummeriere verbleibende Sätze dieser Übung sauber neu (1..N)
      const remaining = await db.sets
        .where('[workoutId+exerciseId]')
        .equals([Number(state.activeWorkoutId), exerciseId])
        .toArray();
      remaining.sort((a, b) => a.setNumber - b.setNumber);

      for (let i = 0; i < remaining.length; i++) {
        await db.sets.update(remaining[i].id, { setNumber: i + 1 });
      }

      const exercise = await db.exercises.get(exerciseId);
      const stats = await getExerciseStats(exerciseId, state.activeWorkoutId);
      const listEl = document.querySelector(`[data-sets-list="${exerciseId}"]`);
      if (listEl && exercise) {
        const updatedSets = await db.sets
          .where('[workoutId+exerciseId]')
          .equals([Number(state.activeWorkoutId), exerciseId])
          .toArray();
        updatedSets.sort((a, b) => a.setNumber - b.setNumber);
        listEl.innerHTML = updatedSets
          .map((s, idx) => {
            const refSet = stats.lastSets[idx] || stats.lastSets[stats.lastSets.length - 1] || null;
            return renderSetRowHtml(s, exercise, refSet);
          })
          .join('');
      }
      await refreshExerciseBadgesInDOM(exerciseId);
    }

    if (action === 'finish-workout') {
      const workoutId = Number(btn.dataset.workoutId);
      // Entferne nicht abgeschlossene Sätze oder behalte das Workout sauber als completed
      await db.workouts.update(workoutId, {
        completed: true,
        date: Date.now()
      });
      state.activeWorkoutId = null;
      stopRestTimer();
      showToast('🏆 Training abgeschlossen & gespeichert!');
      await navigateTo('home');
    }

    // --- PAUSENZEIT MODAL ---
    if (action === 'edit-rest-time') {
      const exerciseId = Number(btn.dataset.exerciseId);
      await openEditRestModal(exerciseId);
    }

    if (action === 'preset-rest') {
      const sec = Number(btn.dataset.seconds);
      const input = document.getElementById('modal-rest-input');
      if (input) input.value = String(sec);
    }

    if (action === 'close-modal') {
      closeModal();
    }

    // --- ROUTINE VERWALTUNG ---
    if (action === 'draft-add-exercise') {
      const exId = Number(btn.dataset.exerciseId);
      const nameInput = document.getElementById('routine-name-input');
      const currentName = nameInput?.value || '';
      state.manageRoutineDraftIds.push(exId);
      await renderCurrentView();
      const restoredInput = document.getElementById('routine-name-input');
      if (restoredInput) restoredInput.value = currentName;
    }

    if (action === 'draft-move-up') {
      const idx = Number(btn.dataset.index);
      const nameInput = document.getElementById('routine-name-input');
      const currentName = nameInput?.value || '';
      if (idx > 0) {
        const tmp = state.manageRoutineDraftIds[idx - 1];
        state.manageRoutineDraftIds[idx - 1] = state.manageRoutineDraftIds[idx];
        state.manageRoutineDraftIds[idx] = tmp;
        await renderCurrentView();
        const restoredInput = document.getElementById('routine-name-input');
        if (restoredInput) restoredInput.value = currentName;
      }
    }

    if (action === 'draft-move-down') {
      const idx = Number(btn.dataset.index);
      const nameInput = document.getElementById('routine-name-input');
      const currentName = nameInput?.value || '';
      if (idx < state.manageRoutineDraftIds.length - 1) {
        const tmp = state.manageRoutineDraftIds[idx + 1];
        state.manageRoutineDraftIds[idx + 1] = state.manageRoutineDraftIds[idx];
        state.manageRoutineDraftIds[idx] = tmp;
        await renderCurrentView();
        const restoredInput = document.getElementById('routine-name-input');
        if (restoredInput) restoredInput.value = currentName;
      }
    }

    if (action === 'draft-remove') {
      const idx = Number(btn.dataset.index);
      const nameInput = document.getElementById('routine-name-input');
      const currentName = nameInput?.value || '';
      state.manageRoutineDraftIds.splice(idx, 1);
      await renderCurrentView();
      const restoredInput = document.getElementById('routine-name-input');
      if (restoredInput) restoredInput.value = currentName;
    }

    if (action === 'edit-routine') {
      const routineId = Number(btn.dataset.routineId);
      const routine = await db.routines.get(routineId);
      if (!routine) return;
      state.editingRoutineId = routine.id;
      state.manageRoutineDraftIds = [...(routine.exerciseIds || [])];
      await renderCurrentView();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    if (action === 'cancel-edit-routine') {
      state.editingRoutineId = null;
      state.manageRoutineDraftIds = [];
      await renderCurrentView();
    }

    if (action === 'delete-routine') {
      const routineId = Number(btn.dataset.routineId);
      await db.routines.delete(routineId);
      if (state.editingRoutineId === routineId) {
        state.editingRoutineId = null;
        state.manageRoutineDraftIds = [];
      }
      showToast('Routine gelöscht');
      await renderCurrentView();
    }

    if (action === 'delete-exercise') {
      const exId = Number(btn.dataset.exerciseId);
      await db.exercises.delete(exId);
      // Entferne die Übung auch aus allen Routinen
      const routines = await db.routines.toArray();
      for (const r of routines) {
        if ((r.exerciseIds || []).includes(exId)) {
          await db.routines.update(r.id, {
            exerciseIds: r.exerciseIds.filter((id) => Number(id) !== exId)
          });
        }
      }
      showToast('Übung gelöscht');
      await renderCurrentView();
    }

    // --- BACKUP & SETTINGS ACTIONS ---
    if (action === 'export-backup') {
      const backup = await exportDatabaseToJson();
      const jsonStr = JSON.stringify(backup, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const dateStr = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `iron-gym-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('JSON-Backup heruntergeladen');
    }

    if (action === 'test-timer-sound') {
      triggerTimerAlarm();
      showToast('Audio-Beep & Vibration ausgelöst');
    }

    if (action === 'test-timer-5s') {
      startRestTimer(5, 'Test-Übung');
    }
  });
}

// ============================================================================
// INITIALISIERUNG & SERVICE WORKER REGISTRIERUNG
// ============================================================================

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch (err) {
      console.warn('Service Worker Registrierung fehlgeschlagen:', err);
    }
  }
}

async function initApp() {
  try {
    unlockAudioContextOnce();
    bindEvents();

    await ensureSeedData();

    // Falls noch ein Timer im localStorage läuft, sofort wieder aufnehmen
    if (getStoredTimer()) {
      syncRestTimerUI();
      ensureTimerLoop();
    }

    updateNavHighlight();
    await renderCurrentView();
    await registerServiceWorker();
  } catch (err) {
    console.error('Initialisierungsfehler:', err);
    const main = document.getElementById('app-main');
    if (main) {
      main.innerHTML = `
        <div class="rounded-2xl bg-rose-950/60 border border-rose-500 p-4 text-rose-200 text-xs space-y-2">
          <div class="font-black text-sm">Fehler beim Starten der App:</div>
          <div class="font-mono break-all">${escapeHtml(err?.message || String(err))}</div>
          <p class="text-zinc-300">Bitte stelle sicher, dass alle Dateien (<code>index.html</code>, <code>app.js</code>, <code>db.js</code>, <code>dexie.min.js</code>) im selben GitHub-Ordner liegen.</p>
        </div>
      `;
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
