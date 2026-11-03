/**
 * db.js — IndexedDB / Dexie.js Datenbank-Layer für IRON Gym-Tracker
 *
 * Schema:
 * - exercises: ++id, name, defaultRestSeconds, targetSets
 * - routines:  ++id, name, *exerciseIds
 * - workouts:  ++id, routineId, date, completed
 * - sets:      ++id, workoutId, exerciseId, setNumber, weight, reps, completed, timestamp, [workoutId+exerciseId]
 */

const db = new Dexie('IronGymTrackerDB');

db.version(1).stores({
  exercises: '++id, name, defaultRestSeconds, targetSets',
  routines: '++id, name, *exerciseIds',
  workouts: '++id, routineId, date, completed',
  sets: '++id, workoutId, exerciseId, setNumber, weight, reps, completed, timestamp, [workoutId+exerciseId]'
});

/**
 * Formatiert ein Gewicht sauber ohne unnötige Nachkommastellen (z. B. 80 -> "80", 37.5 -> "37.5", 62.25 -> "62.25")
 */
function formatWeight(weight) {
  const num = Number(weight);
  if (!Number.isFinite(num)) return '0';
  return Number(num.toFixed(2)).toString();
}

/**
 * Initialisiert sinnvolle Seed-Daten (Push, Pull, Legs + Beispiel-Historie),
 * falls die Datenbank noch leer ist, damit Smart Pre-Fill, "Letztes Mal" und "PR" sofort testbar sind.
 */
async function ensureSeedData() {
  const exerciseCount = await db.exercises.count();
  if (exerciseCount > 0) return;

  await db.transaction('rw', db.exercises, db.routines, db.workouts, db.sets, async () => {
    // 1. Übungen anlegen
    const exIds = await db.exercises.bulkAdd(
      [
        // Push
        { name: 'Bankdrücken (Langhantel)', defaultRestSeconds: 180, targetSets: 3 },
        { name: 'Schrägbankdrücken (Kurzhantel)', defaultRestSeconds: 120, targetSets: 3 },
        { name: 'Schulterdrücken (Kurzhantel)', defaultRestSeconds: 120, targetSets: 3 },
        { name: 'Seitheben (Kabel/KH)', defaultRestSeconds: 90, targetSets: 4 },
        { name: 'Trizepsdrücken am Kabel', defaultRestSeconds: 90, targetSets: 3 },
        // Pull
        { name: 'Klimmzüge / Latzug', defaultRestSeconds: 150, targetSets: 3 },
        { name: 'Langhantelrudern', defaultRestSeconds: 150, targetSets: 3 },
        { name: 'Rudern eng am Kabel', defaultRestSeconds: 120, targetSets: 3 },
        { name: 'Face Pulls', defaultRestSeconds: 90, targetSets: 3 },
        { name: 'LH- / SZ-Bizepscurls', defaultRestSeconds: 90, targetSets: 3 },
        // Legs
        { name: 'Kniebeugen (Langhantel)', defaultRestSeconds: 180, targetSets: 3 },
        { name: 'Rumänisches Kreuzheben (RDL)', defaultRestSeconds: 150, targetSets: 3 },
        { name: 'Beinpresse', defaultRestSeconds: 120, targetSets: 3 },
        { name: 'Wadenheben stehend', defaultRestSeconds: 90, targetSets: 4 }
      ],
      { allKeys: true }
    );

    const [
      benchId,
      inclineDbId,
      shoulderPressId,
      lateralRaiseId,
      tricepsId,
      pullupId,
      barbellRowId,
      cableRowId,
      facePullId,
      curlId,
      squatId,
      rdlId,
      legPressId,
      calfId
    ] = exIds;

    // 2. Routinen anlegen (Push, Pull, Beine)
    const routineIds = await db.routines.bulkAdd(
      [
        {
          name: 'Push (Brust, Schulter, Trizeps)',
          exerciseIds: [benchId, inclineDbId, shoulderPressId, lateralRaiseId, tricepsId]
        },
        {
          name: 'Pull (Rücken, hintere Schulter, Bizeps)',
          exerciseIds: [pullupId, barbellRowId, cableRowId, facePullId, curlId]
        },
        {
          name: 'Legs (Beine & Rumpf)',
          exerciseIds: [squatId, rdlId, legPressId, calfId]
        }
      ],
      { allKeys: true }
    );

    const [pushRoutineId, pullRoutineId] = routineIds;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // 3. Beispiel-Vergangenheits-Workouts anlegen, damit "Letztes Mal", "PR" und Smart Pre-Fill sofort sichtbar sind!
    // Älteres Push-Workout (vor 7 Tagen) mit einem schweren PR-Satz beim Bankdrücken
    const oldPushWorkoutId = await db.workouts.add({
      routineId: pushRoutineId,
      date: now - 7 * dayMs,
      completed: true
    });

    await db.sets.bulkAdd([
      { workoutId: oldPushWorkoutId, exerciseId: benchId, setNumber: 1, weight: 82.5, reps: 6, completed: true, timestamp: now - 7 * dayMs },
      { workoutId: oldPushWorkoutId, exerciseId: benchId, setNumber: 2, weight: 80, reps: 7, completed: true, timestamp: now - 7 * dayMs + 180000 },
      { workoutId: oldPushWorkoutId, exerciseId: benchId, setNumber: 3, weight: 77.5, reps: 8, completed: true, timestamp: now - 7 * dayMs + 360000 },

      { workoutId: oldPushWorkoutId, exerciseId: inclineDbId, setNumber: 1, weight: 30, reps: 8, completed: true, timestamp: now - 7 * dayMs + 600000 },
      { workoutId: oldPushWorkoutId, exerciseId: inclineDbId, setNumber: 2, weight: 30, reps: 8, completed: true, timestamp: now - 7 * dayMs + 720000 }
    ]);

    // Letztes Push-Workout (vor 3 Tagen) -> dient als Quelle für "Letztes Mal" und Smart Pre-Fill
    const lastPushWorkoutId = await db.workouts.add({
      routineId: pushRoutineId,
      date: now - 3 * dayMs,
      completed: true
    });

    await db.sets.bulkAdd([
      // Bankdrücken: Letztes Mal 80kg x 8 | 80kg x 8 | 77.5kg x 7 (während PR von vor 7 Tagen 82.5kg x 6 ist!)
      { workoutId: lastPushWorkoutId, exerciseId: benchId, setNumber: 1, weight: 80, reps: 8, completed: true, timestamp: now - 3 * dayMs },
      { workoutId: lastPushWorkoutId, exerciseId: benchId, setNumber: 2, weight: 80, reps: 8, completed: true, timestamp: now - 3 * dayMs + 180000 },
      { workoutId: lastPushWorkoutId, exerciseId: benchId, setNumber: 3, weight: 77.5, reps: 7, completed: true, timestamp: now - 3 * dayMs + 360000 },

      // Schrägbank KH: 32kg x 8 | 32kg x 8 | 30kg x 7
      { workoutId: lastPushWorkoutId, exerciseId: inclineDbId, setNumber: 1, weight: 32, reps: 8, completed: true, timestamp: now - 3 * dayMs + 500000 },
      { workoutId: lastPushWorkoutId, exerciseId: inclineDbId, setNumber: 2, weight: 32, reps: 8, completed: true, timestamp: now - 3 * dayMs + 620000 },
      { workoutId: lastPushWorkoutId, exerciseId: inclineDbId, setNumber: 3, weight: 30, reps: 7, completed: true, timestamp: now - 3 * dayMs + 740000 },

      // Schulterdrücken KH
      { workoutId: lastPushWorkoutId, exerciseId: shoulderPressId, setNumber: 1, weight: 24, reps: 9, completed: true, timestamp: now - 3 * dayMs + 900000 },
      { workoutId: lastPushWorkoutId, exerciseId: shoulderPressId, setNumber: 2, weight: 24, reps: 8, completed: true, timestamp: now - 3 * dayMs + 1020000 },
      { workoutId: lastPushWorkoutId, exerciseId: shoulderPressId, setNumber: 3, weight: 22, reps: 9, completed: true, timestamp: now - 3 * dayMs + 1140000 },

      // Seitheben
      { workoutId: lastPushWorkoutId, exerciseId: lateralRaiseId, setNumber: 1, weight: 12.5, reps: 12, completed: true, timestamp: now - 3 * dayMs + 1300000 },
      { workoutId: lastPushWorkoutId, exerciseId: lateralRaiseId, setNumber: 2, weight: 12.5, reps: 12, completed: true, timestamp: now - 3 * dayMs + 1390000 },
      { workoutId: lastPushWorkoutId, exerciseId: lateralRaiseId, setNumber: 3, weight: 12.5, reps: 11, completed: true, timestamp: now - 3 * dayMs + 1480000 },
      { workoutId: lastPushWorkoutId, exerciseId: lateralRaiseId, setNumber: 4, weight: 10, reps: 14, completed: true, timestamp: now - 3 * dayMs + 1570000 },

      // Trizepsdrücken
      { workoutId: lastPushWorkoutId, exerciseId: tricepsId, setNumber: 1, weight: 27.5, reps: 12, completed: true, timestamp: now - 3 * dayMs + 1700000 },
      { workoutId: lastPushWorkoutId, exerciseId: tricepsId, setNumber: 2, weight: 27.5, reps: 11, completed: true, timestamp: now - 3 * dayMs + 1790000 },
      { workoutId: lastPushWorkoutId, exerciseId: tricepsId, setNumber: 3, weight: 25, reps: 12, completed: true, timestamp: now - 3 * dayMs + 1880000 }
    ]);

    // Letztes Pull-Workout (vor 2 Tagen)
    const lastPullWorkoutId = await db.workouts.add({
      routineId: pullRoutineId,
      date: now - 2 * dayMs,
      completed: true
    });

    await db.sets.bulkAdd([
      { workoutId: lastPullWorkoutId, exerciseId: pullupId, setNumber: 1, weight: 75, reps: 8, completed: true, timestamp: now - 2 * dayMs },
      { workoutId: lastPullWorkoutId, exerciseId: pullupId, setNumber: 2, weight: 75, reps: 8, completed: true, timestamp: now - 2 * dayMs + 150000 },
      { workoutId: lastPullWorkoutId, exerciseId: pullupId, setNumber: 3, weight: 70, reps: 9, completed: true, timestamp: now - 2 * dayMs + 300000 },

      { workoutId: lastPullWorkoutId, exerciseId: barbellRowId, setNumber: 1, weight: 70, reps: 8, completed: true, timestamp: now - 2 * dayMs + 500000 },
      { workoutId: lastPullWorkoutId, exerciseId: barbellRowId, setNumber: 2, weight: 70, reps: 8, completed: true, timestamp: now - 2 * dayMs + 650000 },
      { workoutId: lastPullWorkoutId, exerciseId: barbellRowId, setNumber: 3, weight: 67.5, reps: 8, completed: true, timestamp: now - 2 * dayMs + 800000 },

      { workoutId: lastPullWorkoutId, exerciseId: cableRowId, setNumber: 1, weight: 65, reps: 10, completed: true, timestamp: now - 2 * dayMs + 1000000 },
      { workoutId: lastPullWorkoutId, exerciseId: cableRowId, setNumber: 2, weight: 65, reps: 10, completed: true, timestamp: now - 2 * dayMs + 1120000 },
      { workoutId: lastPullWorkoutId, exerciseId: cableRowId, setNumber: 3, weight: 60, reps: 11, completed: true, timestamp: now - 2 * dayMs + 1240000 },

      { workoutId: lastPullWorkoutId, exerciseId: facePullId, setNumber: 1, weight: 22.5, reps: 15, completed: true, timestamp: now - 2 * dayMs + 1400000 },
      { workoutId: lastPullWorkoutId, exerciseId: facePullId, setNumber: 2, weight: 22.5, reps: 15, completed: true, timestamp: now - 2 * dayMs + 1490000 },
      { workoutId: lastPullWorkoutId, exerciseId: facePullId, setNumber: 3, weight: 22.5, reps: 14, completed: true, timestamp: now - 2 * dayMs + 1580000 },

      { workoutId: lastPullWorkoutId, exerciseId: curlId, setNumber: 1, weight: 32.5, reps: 10, completed: true, timestamp: now - 2 * dayMs + 1700000 },
      { workoutId: lastPullWorkoutId, exerciseId: curlId, setNumber: 2, weight: 32.5, reps: 9, completed: true, timestamp: now - 2 * dayMs + 1790000 },
      { workoutId: lastPullWorkoutId, exerciseId: curlId, setNumber: 3, weight: 30, reps: 10, completed: true, timestamp: now - 2 * dayMs + 1880000 }
    ]);
  });
}

/**
 * Prüft, ob es heute (oder generell) ein noch nicht abgeschlossenes Workout gibt.
 */
async function getActiveWorkoutOfToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startMs = startOfDay.getTime();

  const allOpenWorkouts = await db.workouts
    .filter((w) => !w.completed && w.date >= startMs)
    .toArray();

  if (allOpenWorkouts.length === 0) return null;
  allOpenWorkouts.sort((a, b) => b.date - a.date);
  return allOpenWorkouts[0];
}

/**
 * Ermittelt für eine Übung:
 * 1) "lastSets": Alle abgeschlossenen Sätze aus dem zeitlich letzten Workout (außer currentWorkoutId),
 *    in dem mindestens 1 Satz dieser Übung abgeschlossen wurde.
 * 2) "prSet": Den All-Time PR nach real bewegtem Höchstgewicht (`max(weight)`), bei Gleichstand `max(reps)`
 *    über alle jemals abgeschlossenen Sätze dieser Übung.
 */
async function getExerciseStats(exerciseId, currentWorkoutId = null) {
  const allExerciseSets = await db.sets
    .where('exerciseId')
    .equals(Number(exerciseId))
    .toArray();

  const completedSets = allExerciseSets.filter(
    (s) => s.completed === true && Number(s.reps) > 0
  );

  // 1. All-Time PR berechnen (höchstes reales Gewicht, bei Gleichstand höchste Wdh)
  let prSet = null;
  for (const s of completedSets) {
    const w = Number(s.weight) || 0;
    const r = Number(s.reps) || 0;
    if (!prSet) {
      prSet = { weight: w, reps: r, workoutId: s.workoutId };
    } else if (w > prSet.weight || (w === prSet.weight && r > prSet.reps)) {
      prSet = { weight: w, reps: r, workoutId: s.workoutId };
    }
  }

  // 2. "Letztes Mal" berechnen (aus dem zeitlich letzten Workout vor/außerhalb von currentWorkoutId)
  const previousSets = completedSets.filter(
    (s) => s.workoutId !== Number(currentWorkoutId)
  );

  if (previousSets.length === 0) {
    return { lastSets: [], prSet, lastWorkoutDate: null };
  }

  const workoutIds = [...new Set(previousSets.map((s) => s.workoutId))];
  const workouts = await db.workouts.bulkGet(workoutIds);
  const validWorkouts = workouts.filter(Boolean);

  let latestWorkout = null;
  for (const w of validWorkouts) {
    if (!latestWorkout || w.date > latestWorkout.date) {
      latestWorkout = w;
    }
  }

  if (!latestWorkout) {
    return { lastSets: [], prSet, lastWorkoutDate: null };
  }

  const lastSets = previousSets
    .filter((s) => s.workoutId === latestWorkout.id)
    .sort((a, b) => a.setNumber - b.setNumber);

  return {
    lastSets,
    prSet,
    lastWorkoutDate: latestWorkout.date
  };
}

/**
 * Startet ein neues Workout für eine Routine und erzeugt direkt die vorbefüllten Satz-Zeilen
 * (Smart Pre-Fill aus dem jeweils letzten Workout jeder Übung oder `targetSets`).
 */
async function createWorkoutFromRoutine(routineId) {
  const routine = await db.routines.get(Number(routineId));
  if (!routine) throw new Error('Routine nicht gefunden');

  const now = Date.now();
  const workoutId = await db.workouts.add({
    routineId: routine.id,
    date: now,
    completed: false
  });

  const exercises = await db.exercises.bulkGet(routine.exerciseIds.map(Number));
  const setsToCreate = [];

  for (const exercise of exercises) {
    if (!exercise) continue;
    const { lastSets } = await getExerciseStats(exercise.id, workoutId);
    const numSets =
      lastSets.length > 0
        ? lastSets.length
        : Math.max(1, Number(exercise.targetSets) || 3);

    for (let i = 0; i < numSets; i++) {
      const refSet = lastSets[i] || lastSets[lastSets.length - 1] || null;
      setsToCreate.push({
        workoutId,
        exerciseId: exercise.id,
        setNumber: i + 1,
        weight: refSet ? Number(refSet.weight) : '',
        reps: refSet ? Number(refSet.reps) : '',
        completed: false,
        timestamp: now
      });
    }
  }

  if (setsToCreate.length > 0) {
    await db.sets.bulkAdd(setsToCreate);
  }

  return workoutId;
}

/**
 * Exportiert die gesamte IndexedDB als JSON-Objekt für das lokale Backup.
 */
async function exportDatabaseToJson() {
  const [exercises, routines, workouts, sets] = await Promise.all([
    db.exercises.toArray(),
    db.routines.toArray(),
    db.workouts.toArray(),
    db.sets.toArray()
  ]);

  return {
    app: 'IRON-Gym-Tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      exercises,
      routines,
      workouts,
      sets
    }
  };
}

/**
 * Importiert ein JSON-Backup und stellt alle Tabellen wieder her.
 */
async function importDatabaseFromJson(backupObj) {
  if (!backupObj || !backupObj.data) {
    throw new Error('Ungültiges Backup-Format: "data"-Objekt fehlt.');
  }
  const { exercises, routines, workouts, sets } = backupObj.data;
  if (
    !Array.isArray(exercises) ||
    !Array.isArray(routines) ||
    !Array.isArray(workouts) ||
    !Array.isArray(sets)
  ) {
    throw new Error('Ungültiges Backup-Format: Tabellen sind keine Arrays.');
  }

  await db.transaction('rw', db.exercises, db.routines, db.workouts, db.sets, async () => {
    await Promise.all([
      db.exercises.clear(),
      db.routines.clear(),
      db.workouts.clear(),
      db.sets.clear()
    ]);

    if (exercises.length) await db.exercises.bulkPut(exercises);
    if (routines.length) await db.routines.bulkPut(routines);
    if (workouts.length) await db.workouts.bulkPut(workouts);
    if (sets.length) await db.sets.bulkPut(sets);
  });
}

window.GymDB = {
  db,
  formatWeight,
  ensureSeedData,
  getActiveWorkoutOfToday,
  getExerciseStats,
  createWorkoutFromRoutine,
  exportDatabaseToJson,
  importDatabaseFromJson
};
