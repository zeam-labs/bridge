<?php

namespace ZeamPass\Settlement;

final class CacheHolds implements Holds
{
    private $cache;

    public function __construct(Cache $cache)
    {
        $this->cache = $cache;
    }

    private static function name($key)
    {
        return 'zeam_pass_mpp_' . sha1((string) $key);
    }

    public function claim($key, $untilMs, $nowMs)
    {
        return (bool) $this->cache->add(self::name($key), 1, max(1, intdiv((int) $untilMs - (int) $nowMs, 1000)));
    }

    public function release($key)
    {
        $this->cache->set(self::name($key), 0, 1);
    }
}
