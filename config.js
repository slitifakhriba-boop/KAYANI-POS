/* KAYANI POS — connexion à Supabase.
   Renseignez l'URL du projet et la clé publique « anon » (Supabase › Project Settings › API).
   La clé anon est faite pour être publique : la sécurité repose sur la connexion et les droits (RLS).
   NE JAMAIS mettre ici la clé « service_role ».
   Laissez vide pour lancer l'application en mode démonstration (données fictives). */
window.KAYANI_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: ''
};
