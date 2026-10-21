<?php

namespace App\Enums;

enum UserRole: string
{
    case Admin = 'admin';
    case SalesManager = 'sales_manager';
    case SalesRep = 'sales_rep';
}
