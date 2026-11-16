<?php
declare(strict_types=1);

/**
 * Point d'entrée principal du backend PHP 8 natif généré par Universal Clone.
 * Résout la route demandée (directe ou passée via ?__route= par clone-shim.js)
 * et délègue au Router.
 */
require_once __DIR__ . '/includes/Response.php';
require_once __DIR__ . '/includes/Validator.php';
require_once __DIR__ . '/includes/Database.php';
require_once __DIR__ . '/includes/Router.php';

$appConfig = require __DIR__ . '/config/config.php';
Response::sendCorsHeaders((string)($appConfig['cors_allowed_origin'] ?? '*'));

$router = new Router();

// Enregistrement des routes générées
__ROUTES_REGISTRATION__

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$rawRoute = $_GET['__route'] ?? ($_SERVER['REQUEST_URI'] ?? '/');
$parsedUrl = parse_url((string)$rawRoute);
$uriPath = $parsedUrl['path'] ?? '/';

// Si __route contenait sa propre query string (ex: /api/quotes?page=2), fusionner dans $_GET
if (!empty($parsedUrl['query'])) {
    parse_str($parsedUrl['query'], $extraQuery);
    $_GET = array_merge($extraQuery, $_GET);
}

// Retirer le préfixe /backend/index.php si appelé directement
$uriPath = preg_replace('#^.*?/backend/index\.php#', '', $uriPath) ?: '/';

$router->dispatch($method, $uriPath);
