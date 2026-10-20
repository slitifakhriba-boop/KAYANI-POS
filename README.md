# KAYANI POS

Caisse, clients, agenda et gestion du centre de bien-être **KAYANI**.
Application web installable (PWA) : elle s'installe sur PC, iPhone et iPad, fonctionne **hors ligne** et se **synchronise** avec Supabase dès que la connexion revient.

Version 2.2, 20/10/2026.

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
scripts/              (facultatif sur le site) outils de construction
```
