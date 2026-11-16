<?php
declare(strict_types=1);

/**
 * Classe Response : envoi de réponses JSON normalisées, codes HTTP et en-têtes CORS.
 */
final class Response
{
    public static function sendCorsHeaders(string $allowedOrigin = '*'): void
    {
        header('Access-Control-Allow-Origin: ' . $allowedOrigin);
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    public static function json(mixed $data, int $statusCode = 200): never
    {
        http_response_code($statusCode);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    public static function error(string $message, int $statusCode = 400, string $code = 'BAD_REQUEST'): never
    {
        self::json([
            'error' => true,
            'code' => $code,
            'message' => $message,
        ], $statusCode);
    }
}
