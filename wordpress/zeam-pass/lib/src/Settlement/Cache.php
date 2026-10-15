<?php

namespace ZeamPass\Settlement;

interface Cache
{
    public function get($key);

    public function set($key, $value, $ttlSeconds);

    public function add($key, $value, $ttlSeconds);
}
