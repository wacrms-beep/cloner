"""
Configuration centrale du moteur Python Universal Clone.
Contient la version du moteur, la liste des domaines de trackers connus pour Sanitizer
et les constantes de limites par défaut.
"""

ENGINE_VERSION = "1.0.0"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36 UniversalClone/1.0"
)

MOBILE_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) "
    "Version/17.5 Mobile/15E148 Safari/604.1 UniversalClone/1.0"
)

# Liste de domaines de trackers et d'analytique retirés par Sanitizer lorsque strip_trackers=True
TRACKER_DOMAINS = frozenset({
    "google-analytics.com",
    "www.google-analytics.com",
    "ssl.google-analytics.com",
    "googletagmanager.com",
    "www.googletagmanager.com",
    "doubleclick.net",
    "stats.g.doubleclick.net",
    "connect.facebook.net",
    "www.facebook.com",
    "static.hotjar.com",
    "script.hotjar.com",
    "vars.hotjar.com",
    "clarity.ms",
    "www.clarity.ms",
    "cdn.segment.com",
    "api.segment.io",
    "cdn.mxpnl.com",
    "api.mixpanel.com",
    "plausible.io",
    "matomo.cloud",
    "sc-static.net",
    "analytics.tiktok.com",
    "bat.bing.com",
    "px.ads.linkedin.com",
})

# Motifs de scripts inline de tracking
TRACKER_INLINE_PATTERNS = (
    "GoogleAnalyticsObject",
    "googletagmanager.com/gtm.js",
    "gtag('config'",
    'gtag("config"',
    "fbq('init'",
    'fbq("init"',
    "hj('identify'",
    "_hjSettings",
    "clarity.ms/tag/",
)

MAX_SNIFF_BODY_BYTES = 512 * 1024  # 512 Ko max par réponse JSON capturée

# ====================================================================
# MODULE 1C : INSCRIPTION AUTO, DÉTECTION FORMULAIRES & EXCLUSIONS (§3)
# ====================================================================

# Mots-clés multilingues pour trouver les liens/boutons d'inscription (§3.1)
SIGNUP_KEYWORDS = (
    "register",
    "signup",
    "sign up",
    "sign-up",
    "create account",
    "create an account",
    "inscription",
    "s'inscrire",
    "s’inscrire",
    "créer un compte",
    "creer un compte",
    "rejoindre",
    "join",
    "join now",
    "get started",
    "registrarse",
    "crear cuenta",
    "registrieren",
    "konto erstellen",
)

# Chemins standards de repli pour trouver la page d'inscription (§3.1)
SIGNUP_FALLBACK_PATHS = (
    "/register",
    "/signup",
    "/sign-up",
    "/join",
    "/users/sign_up",
    "/auth/register",
    "/account/register",
)

# Mots-clés multilingues pour trouver la page ou le bouton de connexion (§3.7)
LOGIN_KEYWORDS = (
    "login",
    "log in",
    "sign in",
    "sign-in",
    "connexion",
    "se connecter",
    "identifiant",
    "iniciar sesión",
    "anmelden",
)

LOGIN_FALLBACK_PATHS = (
    "/login",
    "/signin",
    "/sign-in",
    "/users/sign_in",
    "/auth/login",
)

# Liste d'exclusion stricte (§3.8) : banques, administrations, services financiers, plateformes d'identité
EXCLUDED_SIGNUP_DOMAINS = frozenset({
    # Administrations & Identité
    "impots.gouv.fr",
    "ameli.fr",
    "caf.fr",
    "ants.gouv.fr",
    "franceconnect.gouv.fr",
    "service-public.fr",
    "urssaf.fr",
    "msa.fr",
    "lassuranceretraite.fr",
    "francetravail.fr",
    "pole-emploi.fr",
    "gov.uk",
    "irs.gov",
    "ssa.gov",
    "login.gov",
    "id.me",
    # Banques & Services financiers
    "paypal.com",
    "stripe.com",
    "wise.com",
    "revolut.com",
    "n26.com",
    "boursorama.com",
    "boursobank.com",
    "mabanque.bnpparibas",
    "bnpparibas.com",
    "societegenerale.fr",
    "particuliers.societegenerale.fr",
    "credit-agricole.fr",
    "creditmutuel.fr",
    "cic.fr",
    "labanquepostale.fr",
    "caisse-epargne.fr",
    "banquepopulaire.fr",
    "lcl.fr",
    "hsbc.fr",
    "hsbc.com",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citibank.com",
    "binance.com",
    "coinbase.com",
    "kraken.com",
    # Fournisseurs d'identité majeurs
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "appleid.apple.com",
    "okta.com",
    "auth0.com",
})

# Motifs de sous-domaines ou domaines génériques exclus (banques, gouv, etc.)
EXCLUDED_DOMAIN_PATTERNS = (
    ".gouv.fr",
    ".gov",
    ".mil",
    ".edu.fr",
)

# Délai humain aléatoire entre actions d'inscription (§3.8 : 400 - 1200 ms)
HUMAN_DELAY_MIN_MS = 400
HUMAN_DELAY_MAX_MS = 1200

