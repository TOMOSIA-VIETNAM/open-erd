<?php

namespace App\Enums;

enum ActivityType: int
{
    case Call = 1;
    case Email = 2;
    case Meeting = 3;
}
