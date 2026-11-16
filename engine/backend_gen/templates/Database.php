<?php
declare(strict_types=1);

/**
 * Classe Database : singleton PDO 100 % requêtes préparées, charset utf8mb4, erreurs masquées.
 * Utilise MySQL 8 en production (Alwaysdata) et bascule automatiquement sur ../preview.sqlite
 * en local si les identifiants MySQL n'ont pas encore été renseignés.
 */
final class Database
{
    private static ?PDO $instance = null;

    public static function getConnection(): PDO
    {
        if (self::$instance !== null) {
            return self::$instance;
        }

        $dbConfig = require __DIR__ . '/../config/database.php';

        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ];

        try {
            $useSqliteFallback = !empty($dbConfig['sqlite_fallback'])
                && file_exists($dbConfig['sqlite_fallback'])
                && ($dbConfig['password'] === 'VOTRE_MOT_DE_PASSE_MYSQL' || getenv('UCLONE_USE_SQLITE') === '1');

            if ($useSqliteFallback) {
                $dsn = 'sqlite:' . $dbConfig['sqlite_fallback'];
                self::$instance = new PDO($dsn, null, null, $options);
            } else {
                $dsn = sprintf(
                    'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                    $dbConfig['host'],
                    (int)($dbConfig['port'] ?? 3306),
                    $dbConfig['database']
                );
                self::$instance = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], $options);
            }
            return self::$instance;
        } catch (Throwable $e) {
            // Masquer les détails internes de connexion en production
            Response::error('Service de base de données indisponible.', 500, 'DB_CONNECTION_ERROR');
        }
    }
}
