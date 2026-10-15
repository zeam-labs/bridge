<?php

namespace ZeamPass\Settlement;

final class Json
{
    const FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
    const WIRE = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS;

    public static function encode($value)
    {
        $out = json_encode($value, self::FLAGS);
        if ($out === false) {
            throw new \RuntimeException(esc_html('not encodable as JSON: ' . json_last_error_msg()));
        }
        return $out;
    }

    public static function base64($value)
    {
        return base64_encode(self::encode($value));
    }

    public static function decodeHeader($value)
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }
        $raw = base64_decode(trim($value), false);
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }

    public static function isList($value)
    {
        return is_array($value) && ($value === [] || array_keys($value) === range(0, count($value) - 1));
    }

    public static function normalize($value)
    {
        if (!is_array($value)) {
            return $value;
        }
        if (self::isList($value)) {
            return array_map([self::class, 'normalize'], $value);
        }
        $out = [];
        $keys = array_keys($value);
        sort($keys, SORT_STRING);
        foreach ($keys as $k) {
            $out[$k] = self::normalize($value[$k]);
        }
        return $out;
    }

    public static function deepEqual($a, $b)
    {
        return self::encode(self::normalize($a)) === self::encode(self::normalize($b));
    }

    public static function containsSubset($expected, $actual)
    {
        if (!is_array($expected) || self::isList($expected)) {
            return self::deepEqual($expected, $actual);
        }
        if (!is_array($actual) || (self::isList($actual) && $actual !== [])) {
            return false;
        }
        foreach ($expected as $key => $value) {
            if (!array_key_exists($key, $actual)) {
                return false;
            }
            if (!self::containsSubset($value, $actual[$key])) {
                return false;
            }
        }
        return true;
    }
}
