<?php

namespace ZeamPass\Settlement;

final class MppException extends \RuntimeException
{
    public $type;
    public $detail;

    public function __construct($type, $detail)
    {
        parent::__construct('payment refused');
        $this->type = (string) $type;
        $this->detail = (string) $detail;
    }
}
