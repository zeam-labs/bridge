<?php

namespace ZeamPass\Settlement;

interface Holds
{
    public function claim($key, $untilMs, $nowMs);

    public function release($key);
}
