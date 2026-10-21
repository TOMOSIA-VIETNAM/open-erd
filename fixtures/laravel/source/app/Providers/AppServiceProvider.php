<?php

namespace App\Providers;

use App\Models\Company;
use App\Models\Contact;
use App\Models\Deal;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        // *_type columns store these aliases, not class names.
        Relation::enforceMorphMap([
            'company' => Company::class,
            'contact' => Contact::class,
            'deal' => Deal::class,
        ]);
    }
}
