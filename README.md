# KAYANI POS

Caisse, clients, agenda et gestion du centre de bien-être **KAYANI**.
Application web installable (PWA) : elle s'installe sur PC, iPhone et iPad, fonctionne **hors ligne** et se **synchronise** avec Supabase dès que la connexion revient.

Version 3.7, 23/10/2026.

---

## Fonctionnement en bref

| | |
|---|---|
| **Données** | Gardées sur chaque appareil (IndexedDB), puis envoyées à Supabase et partagées entre appareils. |
| **Hors ligne** | Ventes, encaissements, avances, clients, agenda et caisse fonctionnent sans réseau. Le nombre d'opérations en attente s'affiche en haut à droite. |
| **Retour en ligne** | Synchronisation automatique, puis toutes les 20 secondes. Le bouton d'état en haut à droite force une synchronisation. |
| **Numérotation** | Reçus, avances, devis et dépenses : par appareil (`REC-2026-K3-00012`), donc sans collision hors ligne. Factures et avoirs : numéro continu attribué par le serveur (`FAC-2026-00001`), **connexion obligatoire**. |
| **Rôles** | *Administrateur* : tout. *Assistante* : Caisse POS, Clients, Agenda. Les droits sont vérifiés par la base (RLS), pas seulement par l'écran. |
| **Mode démo** | Si `config.js` est vide, l'application tourne avec des données fictives, sans connexion réelle. |

Limites connues :
- La **première connexion** sur un appareil demande Internet.
- Si deux appareils modifient **le même enregistrement** hors ligne, la dernière synchronisation l'emporte. Les ventes et paiements, eux, sont toujours de nouveaux enregistrements et ne se perdent pas.
- La **déconnexion** est refusée tant que des opérations ne sont pas synchronisées, pour ne rien perdre.

---

## Mise en service (une seule fois)

### 1. Base de données Supabase

1. Supabase › votre projet › **SQL Editor** › *New query*.
2. Collez le contenu de [`supabase/schema.sql`](supabase/schema.sql), puis cliquez sur **Run**.
3. Nouvelle requête : collez le fichier **`seed.sql`** remis à part (catalogue et dépenses réelles), puis **Run**.
   > `seed.sql` contient vos dépenses : il n'est **pas** dans ce dépôt, et ne doit pas y être ajouté.

### 2. Comptes utilisateurs

1. Supabase › **Authentication › Users › Add user › Create new user**.
2. Saisissez l'e-mail et le mot de passe, cochez **Auto Confirm User**. Faites-le pour l'administrateur et pour l'assistante.
3. Un nouveau compte n'a **aucun accès** tant qu'il n'est pas activé. Dans **SQL Editor**, activez chaque compte avec son rôle :
   ```sql
   select public.set_role('adresse-de-la-direction@exemple.com', 'admin');
   select public.set_role('adresse-de-l-assistante@exemple.com', 'assistant');
   ```
   Pour retirer l'accès à quelqu'un : `select public.set_role('adresse@exemple.com', 'pending');`
4. Recommandé : Authentication › Sign In / Providers › Email › désactiver **Allow new users to sign up**. Ainsi, seuls les comptes que vous créez existent.

### 3. Relier l'application à Supabase

Dans [`config.js`](config.js), renseignez :
```js
supabaseUrl: 'https://xxxxxxxx.supabase.co',
supabaseAnonKey: 'eyJ…'   // clé « anon / publishable » — jamais la clé service_role
```
La clé *anon* est publique par conception. La sécurité repose sur la connexion et les règles RLS du schéma.

### 4. Publication (GitHub Pages)

Dépôt › **Settings › Pages** › *Source* : **Deploy from a branch** › branche `main`, dossier `/ (root)` › **Save**.
L'application est en ligne quelques minutes plus tard à l'adresse `https://<utilisateur>.github.io/kayani-pos/`.

### 5. Google Agenda (synchronisation dans les deux sens)

L'agenda de KAYANI se synchronise avec l'agenda Google **kayani.therapy@gmail.com** :
- un rendez-vous créé, déplacé ou annulé dans KAYANI apparaît dans Google en quelques secondes ;
- un événement créé dans Google avec un titre « **Prestation — Prénom Nom** » (ex. « Kobido — Amira Ben Salah ») devient un rendez-vous KAYANI. Les autres apparaissent « à relier » dans l'agenda ;
- un déplacement ou une suppression faits dans Google sont repris dans KAYANI.

KAYANI reste la référence pour les capacités, les intervenants, les salles et les paiements. Si un horaire est modifié des deux côtés, la modification la plus récente l'emporte. Un déplacement fait dans Google qui crée un conflit est refusé : le rendez-vous garde son horaire KAYANI, l'événement Google est remis à cet horaire et le conflit est signalé dans l'agenda.

**A. Google Cloud** (avec n'importe quel compte Google, par exemple kayani.therapy@gmail.com)
1. Ouvrir https://console.cloud.google.com › créer un projet « KAYANI POS ».
2. *API et services › Bibliothèque* › rechercher **Google Calendar API** › **Activer**.
3. *API et services › Identifiants* › **Créer des identifiants › Compte de service**. Nom : `kayani-sync` › *Créer et continuer* › ne pas attribuer de rôle › *OK*.
4. Ouvrir ce compte de service › onglet **Clés** › *Ajouter une clé › Créer une clé* › **JSON**. Un fichier se télécharge : il donne accès à l'agenda, **ne le partagez pas et ne le mettez jamais dans ce dépôt**.
5. Noter l'adresse du compte de service (elle se termine par `.iam.gserviceaccount.com`).

**B. Google Agenda** (connecté avec kayani.therapy@gmail.com)
1. https://calendar.google.com › roue dentée › **Paramètres** › dans *Paramètres de mes agendas*, cliquer sur l'agenda kayani.therapy.
2. *Partager avec des personnes ou des groupes spécifiques* › **Ajouter des personnes** › coller l'adresse du compte de service › autorisation **Apporter des modifications aux événements** › *Envoyer*.

**C. Supabase**
1. *SQL Editor › New query* › coller [`supabase/gcal.sql`](supabase/gcal.sql) › **Run**.
2. *Edge Functions › Deploy a new function › Via Editor* › nom exactement **`gcal-sync`** › remplacer tout le code par celui de [`supabase/functions/gcal-sync/index.ts`](supabase/functions/gcal-sync/index.ts) › **Deploy**.
3. Ouvrir la fonction `gcal-sync` › *Details* › désactiver **Verify JWT** (« Enforce JWT verification ») › *Save*. La fonction vérifie elle-même chaque appel.
4. *Edge Functions › Secrets* › ajouter :
   - `GOOGLE_SERVICE_ACCOUNT` : tout le contenu du fichier JSON téléchargé à l'étape A4 ;
   - `GCAL_CALENDAR_ID` : `kayani.therapy@gmail.com`.
5. Dans KAYANI : *Paramètres › Google Agenda › Synchroniser maintenant*. L'état passe à **Connecté**.

Si l'état affiche « Clé de service Supabase absente », ajouter aussi le secret `KAYANI_SERVICE_KEY` avec la clé secrète du projet (*Project Settings › API Keys*).

Pour arrêter la synchronisation : voir la fin de `supabase/gcal.sql`.

Tests du moteur de synchronisation (faux Google Agenda, aucune donnée réelle) :
```
node supabase/functions/gcal-sync/test/sync.test.mjs
node supabase/functions/gcal-sync/test/handler.test.mjs
```

### 6. Version 3 : photos des justificatifs, clubs, équipe, crédits (une seule fois)

1. Supabase › **SQL Editor** › New query.
2. Coller tout le contenu de [`supabase/v3.sql`](supabase/v3.sql) › **Run**.

Cela crée l'espace privé **justificatifs** (photos et scans des factures, ouverts uniquement par l'administration avec un lien temporaire) et ouvre à l'assistante la collection des feuilles de présence des clubs. Les crédits et les données de l'équipe restent réservés à l'administration.

Tant que ce script n'est pas exécuté, l'application fonctionne, mais l'envoi d'une photo de facture affiche « espace justificatifs à créer ».

---

## Installer l'application sur les appareils

- **iPhone / iPad** : ouvrir l'adresse dans **Safari** › bouton **Partager** › **Sur l'écran d'accueil** › Ajouter.
- **PC (Chrome ou Edge)** : ouvrir l'adresse › icône **Installer** dans la barre d'adresse (ou menu › *Installer KAYANI*).
- **Mac (Safari)** : menu **Fichier › Ajouter au Dock**.

Ensuite, se connecter une première fois avec Internet. L'application s'ouvre ensuite comme une app normale, même sans réseau.

---

## Mettre à jour l'application

1. Modifier les fichiers.
2. Dans [`sw.js`](sw.js), changer `VERSION` (par ex. `kayani-2.2.1`). C'est ce qui déclenche la mise à jour sur les appareils.
3. Pousser sur `main`. Sur chaque appareil, un bandeau « Nouvelle version disponible » propose la mise à jour, après avoir enregistré les opérations en cours.

## Structure

Tous les fichiers de l'application sont à la racine (aucun dossier nécessaire) :

```
index.html            application (interface, calculs, écrans)
sync.js               stockage local + synchronisation Supabase
sw.js                 service worker (fonctionnement hors ligne)
manifest.webmanifest  installation (nom, icônes, couleurs)
config.js             URL Supabase + clé publique
supabase.js           client Supabase (embarqué pour le hors ligne)
fonts.css             polices Figtree et Marcellus (intégrées)
*.png                 icônes de l'application
supabase/schema.sql   (facultatif sur le site) tables, droits RLS, numérotation légale
supabase/v3.sql       (facultatif sur le site) justificatifs, droits des nouvelles collections
supabase/gcal.sql     (facultatif sur le site) synchronisation Google Agenda : état privé, déclencheur, tâche planifiée
supabase/functions/gcal-sync/  fonction de synchronisation Google Agenda et ses tests
scripts/              (facultatif sur le site) outils de construction
```
