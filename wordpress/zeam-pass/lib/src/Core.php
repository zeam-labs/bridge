<?php

namespace ZeamPass;

final class Core
{
    public static function missing()
    {
        $missing = [];
        if (Big::backend() === null) {
            $missing[] = 'neither the PHP GMP nor the BCMath extension is loaded (install php-gmp or php-bcmath)';
        }
        if (!function_exists('mb_substr') || !function_exists('mb_strlen')) {
            $missing[] = 'mb_substr and mb_strlen are unavailable (install php-mbstring)';
        }
        return $missing;
    }

    public static function ready()
    {
        return self::missing() === [];
    }

    public static function assertReady()
    {
        $missing = self::missing();
        if ($missing !== []) {
            throw new \RuntimeException(esc_html('ZEAM Bridge cannot sign or settle on this server: ' . implode('; ', $missing) . '.'));
        }
    }
}
