// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();

/* ==========================================================================
   CONFIGURATION
   ========================================================================== */

// Render/Railway imposent leur propre port via process.env.PORT.
// En local, on retombe sur 3000.
const PORT = process.env.PORT || 3000;

// Domaine(s) autorisé(s) à appeler cette API. Remplace par le vrai domaine
// du site AVVA39. Plusieurs domaines possibles (séparés par une virgule
// dans la variable d'environnement CORS_ORIGIN), utile pour tester en local
// tout en gardant la prod protégée.
const allowedOrigins = (process.env.CORS_ORIGIN || 'https://avva39.fr')
  .split(',')
  .map((origin) => origin.trim());

// Fichier utilisé comme stockage simple des abonnements (à la place d'une
// vraie base de données). Fonctionne bien pour un usage léger, mais attention :
// sur le plan gratuit de Render, le disque n'est PAS garanti persistant entre
// deux déploiements. Pour un club avec peu de membres, ça reste largement
// suffisant pour démarrer ; on pourra migrer vers une vraie base plus tard.
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');

/* ==========================================================================
   VÉRIFICATION DES VARIABLES D'ENVIRONNEMENT OBLIGATOIRES
   ========================================================================== */
const requiredEnvVars = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
  console.error(
    `[AVVA39 PUSH] Variables d'environnement manquantes : ${missingEnvVars.join(', ')}`
  );
  console.error('[AVVA39 PUSH] Renseigne-les dans le fichier .env (local) ou dans les réglages de ton hébergeur (production).');
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* ==========================================================================
   STOCKAGE DES ABONNEMENTS (fichier JSON local)
   ========================================================================== */
function loadSubscriptions() {
  try {
    if (fs.existsSync(SUBSCRIPTIONS_FILE)) {
      const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('[AVVA39 PUSH] Erreur de lecture du fichier des abonnements :', err);
  }
  return [];
}

function saveSubscriptions(subscriptions) {
  try {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(subscriptions, null, 2));
  } catch (err) {
    console.error('[AVVA39 PUSH] Erreur d\'écriture du fichier des abonnements :', err);
  }
}

let subscriptions = loadSubscriptions();

/* ==========================================================================
   MIDDLEWARES
   ========================================================================== */
app.use(express.json());

app.use(
  cors({
    origin: (origin, callback) => {
      // Autorise les requêtes sans origine (ex: curl, Postman) et les
      // origines explicitement listées.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origine non autorisée par CORS : ${origin}`));
      }
    }
  })
);

/* ==========================================================================
   ROUTES
   ========================================================================== */

// Vérification rapide que le serveur tourne (utile pour Render/Railway
// et pour un monitoring externe type UptimeRobot, gratuit).
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'AVVA39 push server' });
});

// Enregistrement d'un nouvel abonnement push envoyé par le navigateur
app.post('/api/push/subscribe', (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: 'Abonnement invalide.' });
  }

  // Évite les doublons si le même appareil se réabonne plusieurs fois
  const alreadyExists = subscriptions.some((sub) => sub.endpoint === subscription.endpoint);
  if (!alreadyExists) {
    subscriptions.push(subscription);
    saveSubscriptions(subscriptions);
  }

  res.status(201).json({ ok: true });
});

// Désabonnement (utile si l'utilisateur désactive les notifications côté site)
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  subscriptions = subscriptions.filter((sub) => sub.endpoint !== endpoint);
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});

// Route de test : envoie une notification à tous les abonnés
app.post('/api/push/test', async (req, res) => {
  const payload = JSON.stringify({
    title: 'Test AVVA39',
    body: 'Ceci est une notification de test.',
    type: 'app'
  });

  const results = await Promise.allSettled(
    subscriptions.map((sub) => webpush.sendNotification(sub, payload))
  );

  // Nettoie automatiquement les abonnements expirés (410 Gone / 404)
  const stillValid = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      stillValid.push(subscriptions[i]);
    } else {
      const statusCode = result.reason && result.reason.statusCode;
      if (statusCode !== 404 && statusCode !== 410) {
        stillValid.push(subscriptions[i]); // erreur temporaire, on garde
      }
      console.error('[AVVA39 PUSH] Envoi échoué pour un abonnement :', result.reason && result.reason.message);
    }
  });

  if (stillValid.length !== subscriptions.length) {
    subscriptions = stillValid;
    saveSubscriptions(subscriptions);
  }

  res.json({ ok: true, envoyes: subscriptions.length });
});

/* ==========================================================================
   DÉMARRAGE DU SERVEUR
   ========================================================================== */
app.listen(PORT, () => {
  console.log(`[AVVA39 PUSH] Serveur prêt sur le port ${PORT}`);
});