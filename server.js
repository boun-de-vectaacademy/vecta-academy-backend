/**
 * VECTA ACADEMY — Serveur de référence (Node.js / Express)
 * -----------------------------------------------------------
 * RÈGLE D'ARCHITECTURE (ne pas casser en modifiant ce fichier) :
 * Chariow reste le SEUL système de vérité pour l'affiliation, les
 * ventes, les commissions, les paiements et les retraits. Ce serveur
 * ne fait QUE :
 *   1. Recevoir les webhooks Chariow (Pulses) et vérifier leur origine
 *   2. Copier ces données telles quelles dans Supabase (aucun calcul
 *      de commission, aucune logique de paiement)
 *   3. Exposer une API en lecture pour que l'app VECTA affiche un
 *      tableau de bord identique aux données Chariow
 * VECTA ne gère jamais l'argent, ne déclenche jamais de retrait, et
 * ne recrée pas de système d'affiliation indépendant.
 *
 * Ce fichier est un POINT DE DÉPART à déployer sur un vrai serveur
 * (Render...). Il ne peut pas tourner dans l'environnement de démo
 * Claude (pas d'accès réseau sortant, pas de vraies variables d'env).
 *
 * Installation :
 *   npm install
 *   node server.js
 *
 * Variables d'environnement nécessaires (à mettre dans Render, jamais
 * dans le code ni sur GitHub) :
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_KEY=...        (clé secrète, jamais côté client)
 *   CHARIOW_WEBHOOK_TOKEN=...       (mot de passe choisi par vous,
 *                                    ajouté dans l'URL du Pulse Chariow)
 *   PORT=3000
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1); // Render est derrière un proxy — nécessaire pour express-rate-limit
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/* -------------------------------------------------------
   Limitation des requêtes abusives (rate limiting)
   ------------------------------------------------------- */
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------------------------------------------
   Vérification d'origine du webhook (token secret dans l'URL)
   ------------------------------------------------------- */
function requeteAutorisee(req){
  const token = req.query.token;
  const expected = process.env.CHARIOW_WEBHOOK_TOKEN;
  if (!token || !expected || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/* -------------------------------------------------------
   Validation basique des données reçues
   ------------------------------------------------------- */
function evenementValide(event){
  return event && typeof event.type === 'string' && event.data && event.id;
}

/* -------------------------------------------------------
   Webhook Chariow — Pulses
   ------------------------------------------------------- */
app.post('/webhooks/chariow', webhookLimiter, async (req, res) => {
  if (!requeteAutorisee(req)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const event = req.body;
  if (!evenementValide(event)) {
    return res.status(400).json({ error: 'Payload invalide' });
  }

  try {
    const { error: insertLogError } = await supabase
      .from('evenements_webhook')
      .insert({
        chariow_event_id: event.id,
        type_evenement: event.type,
        payload: event
      });

    if (insertLogError) {
      if (insertLogError.code === '23505') {
        return res.status(200).json({ received: true, duplicate: true });
      }
      throw insertLogError;
    }

    switch (event.type) {

      case 'sale.completed': {
        const { data: utilisateurExistant } = await supabase
          .from('utilisateurs')
          .select('id')
          .eq('email', event.data.buyer_email)
          .maybeSingle();

        let utilisateurId = utilisateurExistant?.id;
        if (!utilisateurId) {
          const { data: created, error: createErr } = await supabase
            .from('utilisateurs')
            .insert({
              vecta_id: 'VECTA-' + Math.floor(100000 + Math.random() * 900000),
              nom: event.data.buyer_name || 'Nouveau membre',
              email: event.data.buyer_email,
              statut: 'actif'
            })
            .select()
            .single();
          if (createErr) throw createErr;
          utilisateurId = created.id;
        }

        await supabase.from('paiements').insert({
          utilisateur_id: utilisateurId,
          chariow_id: event.data.sale_id,
          montant: event.data.amount,
          statut: 'valide'
        });

        if (event.data.affiliate_email) {
          const { data: affilie } = await supabase
            .from('utilisateurs')
            .select('id')
            .eq('email', event.data.affiliate_email)
            .maybeSingle();

          if (affilie) {
            await supabase.from('ventes').insert({
              affilie_id: affilie.id,
              chariow_sale_id: event.data.sale_id,
              produit: event.data.product_name,
              montant: event.data.amount,
              commission: event.data.commission_amount,
              statut: 'confirmee'
            });

            await supabase.rpc('recalculer_agregat_affilie', {
              p_utilisateur_id: affilie.id
            });

            await supabase.from('notifications').insert({
              utilisateur_id: affilie.id,
              titre: '🎉 Nouvelle vente enregistrée',
              message: `Chariow indique ${event.data.commission_amount} FCFA de commission sur "${event.data.product_name}"`,
              type: 'affiliation'
            });
          }
        }
        break;
      }

      case 'refund.processed': {
        await supabase
          .from('ventes')
          .update({ statut: 'remboursee' })
          .eq('chariow_sale_id', event.data.sale_id);
        break;
      }

      case 'affiliate.joined': {
        break;
      }

      default:
        console.log('Événement Chariow non géré :', event.type);
    }

    await supabase
      .from('evenements_webhook')
      .update({ traite: true })
      .eq('chariow_event_id', event.id);

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook chariow] erreur :', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/* -------------------------------------------------------
   API en lecture consommée par l'application web VECTA
   ------------------------------------------------------- */
app.get('/api/utilisateur/par-email/:email', apiLimiter, async (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  const { data, error } = await supabase
    .from('utilisateurs')
    .select('id, vecta_id, nom, email, telephone, photo_url, statut')
    .ilike('email', email)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erreur serveur' });
  if (!data) return res.status(404).json({ error: 'Aucun compte trouvé pour cet email. Le paiement Chariow a-t-il bien été confirmé ?' });
  if (data.statut !== 'actif') return res.status(403).json({ error: 'Compte non actif' });
  res.json(data);
});

app.get('/api/affiliation/:utilisateurId', apiLimiter, async (req, res) => {
  const { data, error } = await supabase
    .from('affiliation')
    .select('*, ventes:ventes(*)')
    .eq('utilisateur_id', req.params.utilisateurId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erreur serveur' });
  if (!data) return res.status(404).json({ error: 'Introuvable' });
  res.json(data);
});

app.get('/api/profil/:utilisateurId', apiLimiter, async (req, res) => {
  const { data, error } = await supabase
    .from('utilisateurs')
    .select('id, vecta_id, nom, email, telephone, photo_url, statut')
    .eq('id', req.params.utilisateurId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Erreur serveur' });
  if (!data) return res.status(404).json({ error: 'Introuvable' });
  res.json(data);
});

/* -------------------------------------------------------
   Gestion centralisée des erreurs non prévues
   ------------------------------------------------------- */
app.use((err, req, res, next) => {
  console.error('[erreur non gérée]', err);
  res.status(500).json({ error: 'Erreur serveur inattendue' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Serveur VECTA prêt (miroir Chariow) — en écoute.');
});
