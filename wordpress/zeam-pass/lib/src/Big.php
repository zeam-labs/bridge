<?php

namespace ZeamPass;

final class Big
{
    const CHUNK = '281474976710656';

    private static $gmp = null;

    public static function backend()
    {
        if (extension_loaded('gmp')) {
            return 'gmp';
        }
        if (extension_loaded('bcmath')) {
            return 'bcmath';
        }
        return null;
    }

    private static function gmp()
    {
        if (self::$gmp === null) {
            $backend = self::backend();
            if ($backend === null) {
                throw new \RuntimeException('neither the PHP GMP nor the BCMath extension is loaded');
            }
            self::$gmp = $backend === 'gmp';
        }
        return self::$gmp;
    }

    public static function is($value)
    {
        return self::gmp() ? $value instanceof \GMP : false;
    }

    public static function init($value, $base = 10)
    {
        if (self::gmp()) {
            return gmp_init($value, $base);
        }
        if (is_int($value)) {
            return (string) $value;
        }
        $v = trim((string) $value);
        $neg = $v !== '' && $v[0] === '-';
        if ($neg) {
            $v = substr($v, 1);
        }
        if ($base === 16) {
            if (strncasecmp($v, '0x', 2) === 0) {
                $v = substr($v, 2);
            }
            if (!preg_match('/^[0-9a-fA-F]+$/D', $v)) {
                throw new \InvalidArgumentException('not a hexadecimal integer');
            }
            $n = self::fromHex($v);
        } elseif ($base === 10) {
            if (!preg_match('/^[0-9]+$/D', $v)) {
                throw new \InvalidArgumentException('not a decimal integer');
            }
            $n = ltrim($v, '0');
            $n = $n === '' ? '0' : $n;
        } else {
            throw new \InvalidArgumentException(esc_html('unsupported base ' . $base));
        }
        return $neg && $n !== '0' ? '-' . $n : $n;
    }

    private static function fromHex($hex)
    {
        $n = '0';
        $head = strlen($hex) % 12;
        $chunks = $head ? [substr($hex, 0, $head)] : [];
        foreach (str_split(substr($hex, $head), 12) as $c) {
            if ($c !== '') {
                $chunks[] = $c;
            }
        }
        foreach ($chunks as $c) {
            $n = bcadd(bcmul($n, self::CHUNK, 0), (string) hexdec($c), 0);
        }
        return $n;
    }

    private static function toHex($n)
    {
        $neg = $n[0] === '-';
        if ($neg) {
            $n = substr($n, 1);
        }
        $hex = '';
        while (bccomp($n, self::CHUNK, 0) >= 0) {
            $hex = str_pad(dechex((int) bcmod($n, self::CHUNK, 0)), 12, '0', STR_PAD_LEFT) . $hex;
            $n = bcdiv($n, self::CHUNK, 0);
        }
        return ($neg ? '-' : '') . dechex((int) $n) . $hex;
    }

    private static function bc($value)
    {
        return is_int($value) ? (string) $value : self::init($value, 10);
    }

    private static function norm($n)
    {
        return $n === '-0' ? '0' : $n;
    }

    public static function strval($n, $base = 10)
    {
        if (self::gmp()) {
            return gmp_strval($n, $base);
        }
        $n = self::bc($n);
        if ($base === 10) {
            return $n;
        }
        if ($base === 16) {
            return self::toHex($n);
        }
        throw new \InvalidArgumentException(esc_html('unsupported base ' . $base));
    }

    public static function intval($n)
    {
        return self::gmp() ? gmp_intval($n) : (int) self::bc($n);
    }

    public static function add($a, $b)
    {
        return self::gmp() ? gmp_add($a, $b) : self::norm(bcadd(self::bc($a), self::bc($b), 0));
    }

    public static function sub($a, $b)
    {
        return self::gmp() ? gmp_sub($a, $b) : self::norm(bcsub(self::bc($a), self::bc($b), 0));
    }

    public static function mul($a, $b)
    {
        return self::gmp() ? gmp_mul($a, $b) : self::norm(bcmul(self::bc($a), self::bc($b), 0));
    }

    public static function div($a, $b)
    {
        return self::gmp() ? gmp_div_q($a, $b) : self::norm(bcdiv(self::bc($a), self::bc($b), 0));
    }

    public static function pow($a, $exp)
    {
        return self::gmp() ? gmp_pow($a, $exp) : self::norm(bcpow(self::bc($a), (string) (int) $exp, 0));
    }

    public static function neg($a)
    {
        return self::gmp() ? gmp_neg($a) : self::norm(bcsub('0', self::bc($a), 0));
    }

    public static function cmp($a, $b)
    {
        return self::gmp() ? gmp_cmp($a, $b) : bccomp(self::bc($a), self::bc($b), 0);
    }

    public static function sign($a)
    {
        if (self::gmp()) {
            return gmp_sign($a);
        }
        $a = self::bc($a);
        return $a === '0' ? 0 : ($a[0] === '-' ? -1 : 1);
    }
}
