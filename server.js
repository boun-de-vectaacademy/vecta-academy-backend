/**
 * VECTA ACADEMY — Serveur de référence (Node.js / Express)
 * -----------------------------------------------------------
 * Ce fichier est un POINT DE DÉPART à déployer sur un vrai serveur
 * (Render, Railway, VPS...). Il ne peut pas tourner dans cet
 * environnement de démo (pas d'accès réseau sortant, pas de
 * variables d'environnement réelles).
 *
 * Il montre comment :
 *  1. Recevoir les Pulses (webhooks) Chariow en sécurité
 *  2. Mettre à jour les statistiques d'un affilié dans Supabase
 *  3. Exposer une API pour que l'app web VECTA lise ces données
 *
 * Installation :
 *   npm init -y
 *   npm install express @supabase/supabase-js crypto dotenv cors
 *   node server.js
 *
 * Variables d'environnement nécessaires (.env) :
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_KEY=...     (clé secrète, JAMAIS côté client)
 *   CHARIOW_WEBHOOK_TOKEN=...   (choisi par vous, ajouté dans l'URL du Pulse)
 *   PORT=3000
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * IMPORTANT : express.json({verify}) nous permet de garder le corps
 * brut de la requête pour vérifier la signature du webhook AVANT
 * de faire confiance aux données.
 */
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

function verifChariowSignature(req){
  // Chariow n'expose pas de secret de signature HMAC par Pulse au moment
  // de l'écriture de ce code : on sécurise donc le webhook avec un token
  // secret que NOUS choisissons, glissé dans l'URL du Pulse
  // (ex: https://xxx.onrender.com/webhooks/chariow?token=VOTRE_TOKEN).
  const token = req.query.token;
  const expected = process.env.CHARIOW_WEBHOOK_TOKEN;
  if (!token || !expected || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/* -------------------------------------------------------
   Webhook Chariow — Pulses (vente finalisée, paiement reçu,
   remboursement, nouvel affilié, etc.)
   ------------------------------------------------------- */
app.post('/webhooks/chariow', async (req, res) => {
  if (!verifChariowSignature(req)) {
    return res.status(401).json({ error: 'Signature invalide' });
  }

  const event = req.body;

  try {
    switch (event.type) {

      case 'sale.completed': {
        const { data: utilisateur } = await supabase
          .from('utilisateurs')
          .select('id')
          .eq('email', event.data.buyer_email)
          .single();

        // Création automatique du compte si premier achat (Règle 1 du cahier des charges)
        let utilisateurId = utilisateur?.id;
        if (!utilisateurId) {
          const { data: created } = await supabase
            .from('utilisateurs')
            .insert({
              vecta_id: 'VECTA-' + Math.floor(100000 + Math.random() * 900000),
              nom: event.data.buyer_name || 'Nouveau membre',
              email: event.data.buyer_email,
              statut: 'actif'
            })
            .select()
            .single();
          utilisateurId = created.id;
          // TODO: envoyer l'email de bienvenue + déclencher l'inscription Systeme.io
        }

        await supabase.from('paiements').insert({
          utilisateur_id: utilisateurId,
          chariow_id: event.data.sale_id,
          montant: event.data.amount,
          statut: 'valide'
        });

        // Si la vente vient d'un affilié, on met à jour ses stats
        if (event.data.affiliate_id) {
          const { data: affilie } = await supabase
            .from('utilisateurs')
            .select('id')
            .eq('vecta_id', event.data.affiliate_ref) // à adapter selon le mapping choisi
            .single();

          if (affilie) {
            await supabase.from('ventes').insert({
              affilie_id: affilie.id,
              chariow_sale_id: event.data.sale_id,
              produit: event.data.product_name,
              montant: event.data.amount,
              commission: event.data.commission_amount,
              statut: 'confirmee'
            });

            await supabase.rpc('incrementer_stats_affilie', {
              p_utilisateur_id: affilie.id,
              p_commission: event.data.commission_amount
            });

            await supabase.from('notifications').insert({
              utilisateur_id: affilie.id,
              titre: '🎉 Nouvelle vente enregistrée',
              message: `Vous avez gagné ${event.data.commission_amount} FCFA sur "${event.data.product_name}"`,
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
        // Un nouvel affilié a rejoint le programme Chariow
        // → à relier à un utilisateur VECTA existant si possible
        break;
      }

      default:
        console.log('Événement Chariow non géré :', event.type);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

/* -------------------------------------------------------
   API consommée par l'application web VECTA
   ------------------------------------------------------- */
app.get('/api/affiliation/:utilisateurId', async (req, res) => {
  const { data, error } = await supabase
    .from('affiliation')
    .select('*, ventes(*)')
    .eq('utilisateur_id', req.params.utilisateurId)
    .single();

  if (error) return res.status(404).json({ error: 'Introuvable' });
  res.json(data);
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Serveur VECTA prêt à recevoir les webhooks Chariow.');
});
