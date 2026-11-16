<?php
declare(strict_types=1);

/**
 * Classe Validator : validation stricte des entrées (types, longueurs, champs requis).
 */
final class Validator
{
    public static function getJsonBody(): array
    {
        $raw = file_get_contents('php://input');
        if ($raw === false || trim($raw) === '') {
            return $_POST ?: [];
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            Response::error('Corps JSON invalide.', 400, 'INVALID_JSON');
        }
        return $decoded;
    }

    public static function sanitizePayload(array $input, array $allowedColumns): array
    {
        $clean = [];
        foreach ($allowedColumns as $col => $rules) {
            if (!array_key_exists($col, $input)) {
                continue;
            }
            $val = $input[$col];
            if ($val === null) {
                if (!empty($rules['nullable'])) {
                    $clean[$col] = null;
                    continue;
                }
                Response::error("Le champ '{$col}' ne peut pas être nul.", 422, 'VALIDATION_ERROR');
            }

            $type = strtoupper((string)($rules['type'] ?? 'VARCHAR'));
            if (str_contains($type, 'INT')) {
                if (!is_numeric($val)) {
                    Response::error("Le champ '{$col}' doit être un entier.", 422, 'VALIDATION_ERROR');
                }
                $clean[$col] = (int)$val;
            } elseif (str_contains($type, 'DEC') || str_contains($type, 'FLOA') || str_contains($type, 'DOUB')) {
                if (!is_numeric($val)) {
                    Response::error("Le champ '{$col}' doit être un nombre.", 422, 'VALIDATION_ERROR');
                }
                $clean[$col] = (float)$val;
            } else {
                $strVal = is_scalar($val) ? (string)$val : json_encode($val, JSON_UNESCAPED_UNICODE);
                $maxLen = (int)($rules['max_length'] ?? 65535);
                if (mb_strlen((string)$strVal) > $maxLen) {
                    Response::error("Le champ '{$col}' dépasse la longueur maximale ({$maxLen}).", 422, 'VALIDATION_ERROR');
                }
                $clean[$col] = $strVal;
            }
        }
        return $clean;
    }
}
