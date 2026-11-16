<?php
declare(strict_types=1);

/**
 * Classe Router : associe les chemins d'origine observés (ex: /api/quotes, /api/quotes/{id})
 * aux contrôleurs d'endpoints générés dans endpoints/<ressource>.php.
 */
final class Router
{
    private array $routes = [];

    public function register(string $method, string $pattern, callable $handler): void
    {
        $regex = '#^' . preg_replace('/\{([a-zA-Z0-9_]+)\}/', '(?P<$1>[^/]+)', rtrim($pattern, '/') ?: '/') . '$#';
        $this->routes[] = [
            'method' => strtoupper($method),
            'pattern' => $pattern,
            'regex' => $regex,
            'handler' => $handler,
        ];
    }

    public function dispatch(string $method, string $uriPath): void
    {
        $cleanMethod = strtoupper($method);
        $cleanPath = '/' . trim($uriPath, '/');

        foreach ($this->routes as $route) {
            if ($route['method'] !== $cleanMethod && $route['method'] !== 'ANY') {
                continue;
            }
            if (preg_match($route['regex'], $cleanPath, $matches)) {
                $params = array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
                ($route['handler'])($params);
                return;
            }
        }

        Response::error('Route API non trouvée : ' . $cleanPath, 404, 'ROUTE_NOT_FOUND');
    }
}
