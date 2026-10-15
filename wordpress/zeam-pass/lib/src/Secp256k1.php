<?php

namespace ZeamPass;

use Elliptic\EC;

final class Secp256k1
{
    const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
    const HALF_N = '7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0';

    private static $ec = null;

    private static function ec()
    {
        Core::assertReady();
        if (self::$ec === null) {
            self::$ec = self::exact(function () {
                return new EC('secp256k1');
            });
        }
        return self::$ec;
    }

    private static function exact(callable $fn)
    {
        if (Big::backend() !== 'bcmath') {
            return $fn();
        }
        $scale = bcscale();
        bcscale(0);
        try {
            return $fn();
        } finally {
            bcscale($scale);
        }
    }

    public static function normalizePrivateKey($key)
    {
        $bin = Hex::toBin(is_string($key) && strncasecmp($key, '0x', 2) !== 0 ? '0x' . $key : $key);
        if (strlen($bin) !== 32) {
            throw new \InvalidArgumentException('a private key is 32 bytes');
        }
        $k = Big::init(bin2hex($bin), 16);
        if (Big::sign($k) <= 0 || Big::cmp($k, Big::init(self::N, 16)) >= 0) {
            throw new \InvalidArgumentException('private key out of range');
        }
        return bin2hex($bin);
    }

    public static function publicKey($key)
    {
        $priv = self::normalizePrivateKey($key);
        $ec = self::ec();
        return '0x' . self::exact(function () use ($ec, $priv) {
            return $ec->keyFromPrivate($priv, 'hex')->getPublic(false, 'hex');
        });
    }

    public static function privateKeyToAddress($key)
    {
        return Address::fromPublicKey(self::publicKey($key));
    }

    public static function signHash($key, $hash)
    {
        $digest = Hex::toBin($hash);
        if (strlen($digest) !== 32) {
            throw new \InvalidArgumentException('a digest is 32 bytes');
        }
        $priv = self::normalizePrivateKey($key);
        $ec = self::ec();
        list($r, $s, $rp) = self::exact(function () use ($ec, $digest, $priv) {
            $sig = $ec->sign(bin2hex($digest), $priv, 'hex', ['canonical' => true]);
            return [$sig->r->toString(16), $sig->s->toString(16), (int) $sig->recoveryParam];
        });
        if ($rp > 1) {
            throw new \RuntimeException('signature recovery id is not representable on Ethereum; retry with a different message');
        }
        $r = str_pad($r, 64, '0', STR_PAD_LEFT);
        $s = str_pad($s, 64, '0', STR_PAD_LEFT);
        return '0x' . $r . $s . sprintf('%02x', 27 + $rp);
    }

    public static function parseSignature($signature)
    {
        $bin = Hex::toBin($signature);
        if (strlen($bin) === 64) {
            $r = substr($bin, 0, 32);
            $vs = substr($bin, 32, 32);
            $yParity = (ord($vs[0]) & 0x80) ? 1 : 0;
            $s = chr(ord($vs[0]) & 0x7f) . substr($vs, 1);
            return ['r' => bin2hex($r), 's' => bin2hex($s), 'yParity' => $yParity];
        }
        if (strlen($bin) !== 65) {
            throw new \InvalidArgumentException('a signature is 65 bytes');
        }
        $v = ord($bin[64]);
        if ($v === 0 || $v === 1) {
            $yParity = $v;
        } elseif ($v === 27 || $v === 28) {
            $yParity = $v - 27;
        } else {
            throw new \InvalidArgumentException(esc_html('invalid signature v: ' . $v));
        }
        return ['r' => bin2hex(substr($bin, 0, 32)), 's' => bin2hex(substr($bin, 32, 32)), 'yParity' => $yParity];
    }

    public static function isLowS($signature)
    {
        $p = self::parseSignature($signature);
        return Big::cmp(Big::init($p['s'], 16), Big::init(self::HALF_N, 16)) <= 0;
    }

    public static function isCanonical($signature)
    {
        $bin = Hex::toBin($signature);
        return strlen($bin) === 65 && in_array(ord($bin[64]), [27, 28], true) && self::isLowS($signature);
    }

    public static function recoverHash($hash, $signature)
    {
        $digest = Hex::toBin($hash);
        if (strlen($digest) !== 32) {
            throw new \InvalidArgumentException('a digest is 32 bytes');
        }
        $p = self::parseSignature($signature);
        $n = Big::init(self::N, 16);
        foreach (['r', 's'] as $part) {
            $x = Big::init($p[$part], 16);
            if (Big::sign($x) <= 0 || Big::cmp($x, $n) >= 0) {
                throw new \InvalidArgumentException(esc_html("signature $part out of range"));
            }
        }
        $ec = self::ec();
        try {
            $point = self::exact(function () use ($ec, $digest, $p) {
                $point = $ec->recoverPubKey(bin2hex($digest), ['r' => $p['r'], 's' => $p['s']], $p['yParity']);
                return $point->isInfinity() ? null : $point->encode('hex', false);
            });
        } catch (\Throwable $e) {
            throw new \InvalidArgumentException('signature does not recover to a point');
        }
        if ($point === null) {
            throw new \InvalidArgumentException('signature recovers to infinity');
        }
        return Address::fromPublicKey('0x' . $point);
    }

    public static function hashMessage($message)
    {
        if (is_array($message) && isset($message['raw'])) {
            $bytes = Hex::toBin($message['raw']);
        } else {
            $bytes = (string) $message;
        }
        return Keccak::hex("\x19Ethereum Signed Message:\n" . strlen($bytes) . $bytes);
    }

    public static function personalSign($key, $message)
    {
        return self::signHash($key, self::hashMessage($message));
    }

    public static function recoverPersonal($message, $signature)
    {
        if (!self::isLowS($signature)) {
            throw new \InvalidArgumentException('signature s is above half the curve order');
        }
        return self::recoverHash(self::hashMessage($message), $signature);
    }

    public static function verifyPersonal($address, $message, $signature)
    {
        try {
            return Address::equals(self::recoverPersonal($message, $signature), $address);
        } catch (\InvalidArgumentException $e) {
            return false;
        }
    }

    public static function signTypedData($key, array $domain, array $types, $primaryType, array $message)
    {
        return self::signHash($key, TypedData::hash($domain, $types, $primaryType, $message));
    }

    public static function recoverTypedData(array $domain, array $types, $primaryType, array $message, $signature)
    {
        return self::recoverHash(TypedData::hash($domain, $types, $primaryType, $message), $signature);
    }
}
